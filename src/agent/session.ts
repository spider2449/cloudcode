import { randomUUID } from "node:crypto";
import { errorResult, type EngineMessage } from "../engine/messages.js";
import { EngineLoop, type ContextSnapshot } from "../engine/loop.js";
import { makeClient } from "../engine/api.js";
import { builtinTools } from "../engine/registry.js";
import { PermissionStore } from "./permissionStore.js";
import { SessionFile } from "../engine/sessions.js";
import { McpManager } from "../engine/mcpClient.js";
import { LspManager } from "../engine/lsp/manager.js";
import { buildSystemPrompt } from "../engine/systemPrompt.js";
import type { ProviderConfig } from "./providers.js";
import type { McpServerConfig, McpServerStatusEntry } from "./mcp.js";
import type { EffortLevel } from "../engine/effort.js";
import { runExtraction, hasMemoryWrites, countModelMessages, MIN_NEW_MESSAGES } from "../engine/extractMemories.js";
import { memoryDir } from "../engine/memoryPaths.js";
import { loadSettings } from "./settings.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

const DEFAULT_MODEL = "claude-sonnet-5";

// Exported for tests: pure decision of whether background extraction should run.
export function shouldExtract(messages: unknown[], fromIndex: number, dir: string): boolean {
  if (countModelMessages(messages, fromIndex) < MIN_NEW_MESSAGES) return false;
  return !hasMemoryWrites(messages, fromIndex, dir);
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  resolve(allow: boolean): void;
}

export interface AgentSessionOptions {
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  resume?: string;
  cwd: string;
  mcpServers?: Record<string, McpServerConfig>;
  onMessage(msg: EngineMessage): void;
  onPermissionRequest(req: PermissionRequest): void;
  onSessionId(id: string): void;
  onMemorySaved?(): void;
}

export class AgentSession {
  private loop: EngineLoop | undefined;
  private abortController: AbortController | undefined;
  private sessionFile: SessionFile | undefined;
  sessionId: string | undefined;
  tools: string[] = [];
  private mcp = new McpManager();
  private lsp = new LspManager();
  private mcpReady: Promise<void> | undefined;
  private extractCursor = 0;

  constructor(private opts: AgentSessionOptions) {}

  start(): void {
    this.sessionId = this.opts.resume ?? randomUUID();
    const resumedMessages = this.opts.resume ? SessionFile.load(this.opts.resume) : [];
    const store = new PermissionStore(this.opts.cwd);
    this.loop = new EngineLoop({
      client: makeClient(this.opts.provider),
      model: this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      systemPrompt: buildSystemPrompt(this.opts.cwd),
      tools: builtinTools(),
      cwd: this.opts.cwd,
      effort: this.opts.effort,
      contextWindow: this.opts.provider.model_context_window,
      permissionMode: this.opts.permissionMode,
      store,
      lsp: this.lsp,
      onMessage: this.opts.onMessage,
      requestPermission: (toolName, input) =>
        new Promise(resolve => this.opts.onPermissionRequest({ toolName, input, resolve }))
    });
    if (resumedMessages.length > 0) this.loop.messages = resumedMessages;
    this.sessionFile = new SessionFile(this.sessionId);
    this.tools = builtinTools().map(t => t.name);
    this.opts.onSessionId(this.sessionId);
    this.opts.onMessage({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      tools: this.tools
    });
    this.mcpReady = this.mcp.connect(this.opts.mcpServers ?? {}).then(() => {
      const mcpTools = this.mcp.tools();
      if (mcpTools.length > 0 && this.loop) {
        this.loop.tools.push(...mcpTools);
        this.tools = [...this.tools, ...mcpTools.map(t => t.name)];
      }
    });
  }

  send(text: string): void {
    this.abortController = new AbortController();
    const before = this.loop?.messages.length ?? 0;
    void this.loop?.runTurn(text, this.abortController.signal).then(() => {
      const added = this.loop?.messages.slice(before) ?? [];
      for (const entry of added) this.sessionFile?.append(entry);
      this.maybeExtractMemories();
    }).catch(err => {
      // runTurn never rejects; this guards the post-turn persistence (e.g.
      // a full disk breaking sessionFile.append) from becoming an unhandled
      // rejection that kills the process.
      this.opts.onMessage(errorResult(
        `Failed to save session: ${err instanceof Error ? err.message : String(err)}`
      ));
    });
  }

  // Fire-and-forget background memory extraction. Never blocks or surfaces
  // errors to the UI. The cursor advances unconditionally so a skipped or
  // failed range is never retried on the next turn.
  private maybeExtractMemories(): void {
    if (loadSettings().autoMemoryEnabled === false) return;
    const messages = this.loop?.messages ?? [];
    const dir = memoryDir(this.opts.cwd);
    const from = this.extractCursor;
    this.extractCursor = messages.length;
    if (!shouldExtract(messages, from, dir)) return;
    void runExtraction({
      client: makeClient(this.opts.provider),
      model: this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      memoryDir: dir,
      messages: [...messages],
      fromIndex: from
    }).then(wrote => {
      if (wrote) {
        void this.refreshSystemPrompt();
        this.opts.onMemorySaved?.();
      }
    }).catch(() => { /* extraction is best-effort; never surface errors */ });
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  async setModel(model: string): Promise<void> {
    this.loop?.setModel(model);
  }

  async setEffort(level: EffortLevel): Promise<void> {
    this.loop?.setEffort(level);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.loop?.setPermissionMode(mode);
  }

  async refreshSystemPrompt(): Promise<void> {
    this.loop?.setSystemPrompt(buildSystemPrompt(this.opts.cwd));
  }

  async mcpStatus(): Promise<McpServerStatusEntry[]> {
    return this.mcp.status();
  }

  async compact(onProgress?: (pct: number) => void): Promise<number | undefined> {
    if (!this.loop) return undefined;
    const estimatedTokens = await this.loop.compact(
      makeClient(this.opts.provider),
      this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      onProgress
    );
    // The session file is append-only during normal turns; compaction is the
    // one place history shrinks, so rewrite the file to match loop.messages
    // or a later resume would reload the stale pre-compact transcript.
    this.sessionFile?.rewrite(this.loop.messages);
    // Old cursor positions point into the discarded history; realign so the
    // next extraction window starts at the compacted state.
    this.extractCursor = this.loop.messages.length;
    return estimatedTokens;
  }

  contextSnapshot(): ContextSnapshot | undefined {
    return this.loop?.contextSnapshot();
  }

  async dispose(): Promise<void> {
    this.abortController?.abort();
    await this.mcp.dispose();
    this.lsp.shutdown();
  }
}
