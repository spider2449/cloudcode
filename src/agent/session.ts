import { randomUUID } from "node:crypto";
import { errorResult, limitMessage, type EngineMessage } from "../engine/messages.js";
import { EngineLoop, type ContextSnapshot } from "../engine/loop.js";
import { makeClient } from "../engine/api.js";
import { builtinTools } from "../engine/registry.js";
import { PermissionStore } from "./permissionStore.js";
import { SessionFile } from "../engine/sessions.js";
import { McpManager } from "../engine/mcpClient.js";
import { LspManager } from "../engine/lsp/manager.js";
import type { ServerConfig } from "../engine/lsp/config.js";
import { buildSystemPrompt } from "../engine/systemPrompt.js";
import type { ProviderConfig } from "./providers.js";
import { mcpHttpDestination, type McpServerConfig, type McpServerStatusEntry } from "./mcp.js";
import type { EffortLevel } from "../engine/effort.js";
import { runExtraction, hasMemoryWrites, countModelMessages, MIN_NEW_MESSAGES } from "../engine/extractMemories.js";
import { memoryDir } from "../engine/memoryPaths.js";
import { loadSettings } from "./settings.js";
import { loadHooksConfig, HooksRunner } from "./hooks.js";
import { BackgroundShellManager, realBgSpawner, sandboxedBgSpawner } from "../engine/tools/backgroundShells.js";
import { type TodoItem, type TodoStore } from "../engine/tools/todo.js";
import { todosMessage } from "../engine/messages.js";
import {
  NetworkPolicy, bashNetworkStatus, providerEndpoint, type NetworkMode
} from "./networkPolicy.js";
import { probeSandboxCached, type SandboxProbeResult } from "./sandbox.js";
import {
  ChangeJournal, type ChangeSummary, type UndoPreview, type UndoResult
} from "./changeJournal.js";
import {
  RunLimitError, validateRunLimits, type RunLimits
} from "../engine/runLimits.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export const DEFAULT_MODEL = "claude-sonnet-5";

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
  /** Base directory for user-level hook config; defaults to configDir(). */
  configBase?: string;
  /** Directory holding session transcripts; defaults to configDir()/sessions. */
  sessionDir?: string;
  mcpServers?: Record<string, McpServerConfig>;
  lspRegistry?: Record<string, ServerConfig>;
  mcpManager?: McpManager;
  changeJournalFactory?: (cwd: string, sessionId: string) => ChangeJournal;
  networkMode?: NetworkMode;
  networkPolicy?: NetworkPolicy;
  /** Probe override for tests; defaults to the cached real machine probe. */
  sandboxProbe?: () => SandboxProbeResult;
  runLimits?: RunLimits;
  toolAllowlist?: readonly string[];
  onMessage(msg: EngineMessage): void;
  onPermissionRequest(req: PermissionRequest): void;
  onSessionId(id: string): void;
  onMemorySaved?(): void;
}

export class AgentSession {
  private loop: EngineLoop | undefined;
  private abortController: AbortController | undefined;
  private sessionFile: SessionFile | undefined;
  private hooksRunner: HooksRunner | undefined;
  private bgShells: BackgroundShellManager | undefined;
  private todos: TodoItem[] = [];
  sessionId: string | undefined;
  tools: string[] = [];
  private mcp: McpManager;
  private lsp: LspManager;
  private mcpReady: Promise<void> | undefined;
  private extractCursor = 0;
  private disposed = false;
  private cancelPendingStart: (() => void) | undefined;
  private changes: ChangeJournal | undefined;
  private turnActive = false;
  private runDeadline: number | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: AgentSessionOptions) {
    this.lsp = new LspManager(opts.lspRegistry);
    this.mcp = opts.mcpManager ?? new McpManager();
  }

  start(): void {
    this.sessionId = this.opts.resume ?? randomUUID();
    const model = this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL;
    validateRunLimits(this.opts.runLimits, model);
    this.runDeadline = this.opts.runLimits?.timeoutMs === undefined
      ? undefined : Date.now() + this.opts.runLimits.timeoutMs;
    const sessionDir = this.opts.sessionDir;
    const resumedMessages = this.opts.resume ? SessionFile.load(this.opts.resume, sessionDir) : [];
    // Todos records are UI state, not API history: pull them out of the
    // transcript before it becomes the conversation, then replay the latest.
    const todoRecords = resumedMessages.filter(e => (e as { type?: string }).type === "todos");
    const resumedHistory = resumedMessages.filter(e => (e as { type?: string }).type !== "todos");
    if (todoRecords.length > 0) {
      const last = todoRecords[todoRecords.length - 1] as { todos?: TodoItem[] };
      if (Array.isArray(last.todos)) this.todos = last.todos;
    }
    const store = new PermissionStore(this.opts.cwd);
    this.changes = this.opts.changeJournalFactory?.(this.opts.cwd, this.sessionId) ??
      new ChangeJournal(this.opts.cwd, this.sessionId);
    const endpoint = providerEndpoint(this.opts.provider);
    const networkPolicy = this.opts.networkPolicy ?? new NetworkPolicy(
      this.opts.networkMode ?? "providerOnly", endpoint
    );
    networkPolicy.require({ capability: "provider", destination: endpoint });
    const probe = (this.opts.sandboxProbe ?? probeSandboxCached)();
    // Wrapping applies ONLY under offlineStrict: in providerOnly/unrestricted
    // children legitimately need the network and must not be confined.
    const sandbox = probe.available && networkPolicy.mode === "offlineStrict" ? probe.adapter : undefined;
    const bash = bashNetworkStatus(networkPolicy.mode, sandbox !== undefined);
    const hooksConfig = loadHooksConfig(this.opts.cwd, this.opts.configBase);
    for (const warning of hooksConfig.warnings) {
      this.opts.onMessage(errorResult(warning));
    }
    if (hooksConfig.projectUntrusted) {
      this.opts.onMessage(errorResult(
        "Project .cloudcode/hooks.json exists but is not trusted; approve the project configuration to enable its hooks."
      ));
    }
    const hooksRunner = new HooksRunner(hooksConfig.hooks, this.opts.cwd);
    this.hooksRunner = hooksRunner;
    void hooksRunner.run("SessionStart").catch(() => {});
    const bgShells = new BackgroundShellManager(sandbox ? sandboxedBgSpawner(sandbox) : realBgSpawner);
    this.bgShells = bgShells;
    const todoStore: TodoStore = {
      get: () => this.todos,
      set: (todos: TodoItem[]) => {
        this.todos = todos;
        this.opts.onMessage(todosMessage(todos));
      }
    };
    const availableTools = builtinTools({
      allowArbitraryChildNetwork: bash.available,
      todoStore,
      bgShells,
      task: {
        client: () => makeClient(this.opts.provider),
        model: () => this.loop?.getModel() ?? model,
        effort: () => this.loop?.getEffort() ?? this.opts.effort ?? "off",
        contextWindow: () => this.opts.provider.model_context_window,
        permissionMode: () => this.loop?.getPermissionMode() ?? this.opts.permissionMode,
        store,
        lsp: this.lsp,
        networkPolicy,
        requestPermission: (toolName, input) =>
          new Promise(resolve => this.opts.onPermissionRequest({ toolName, input, resolve }))
      }
    });
    const tools = this.opts.toolAllowlist
      ? availableTools.filter(tool => this.opts.toolAllowlist?.includes(tool.name))
      : availableTools;
    this.loop = new EngineLoop({
      client: makeClient(this.opts.provider),
      model,
      systemPrompt: buildSystemPrompt(this.opts.cwd),
      tools,
      cwd: this.opts.cwd,
      effort: this.opts.effort,
      contextWindow: this.opts.provider.model_context_window,
      runLimits: this.opts.runLimits,
      permissionMode: this.opts.permissionMode,
      store,
      lsp: this.lsp,
      fileMutations: this.changes,
      networkPolicy,
      bgShells,
      sandbox,
      hooks: {
        guard: async (toolName, input) => {
          const outcome = await hooksRunner.run("PreToolUse", { tool: toolName, input });
          return { blocked: outcome.blocked, reason: outcome.notices.join("; ") || undefined };
        },
        observe: async (event, payload) => {
          await hooksRunner.run(event, payload);
        }
      },
      onMessage: this.opts.onMessage,
      requestPermission: (toolName, input) =>
        new Promise(resolve => this.opts.onPermissionRequest({ toolName, input, resolve }))
    });
    if (resumedHistory.length > 0) this.loop.messages = resumedHistory;
    this.extractCursor = resumedHistory.length;
    this.sessionFile = new SessionFile(this.sessionId, sessionDir);
    this.tools = tools.map(t => t.name);
    this.opts.onSessionId(this.sessionId);
    for (const warning of this.changes.warnings()) this.opts.onMessage(errorResult(warning));
    if (this.todos.length > 0) this.opts.onMessage(todosMessage(this.todos));
    this.opts.onMessage({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      tools: this.tools
    });
    this.mcpReady = this.mcp.connect(this.opts.mcpServers ?? {}, (_name, config) => {
      const destination = mcpHttpDestination(config);
      if (!destination) return undefined;
      const decision = networkPolicy.decide({ capability: "mcpHttp", destination });
      return decision.allowed ? undefined : `${decision.mode}/${decision.reason}`;
    }).then(() => {
      const mcpTools = this.mcp.tools();
      if (mcpTools.length > 0 && this.loop) {
        this.loop.tools.push(...mcpTools);
        this.tools = [...this.tools, ...mcpTools.map(t => t.name)];
      }
    });
  }

  send(text: string, images?: Array<{ mediaType: string; base64: string }>): void {
    if (this.turnActive) {
      this.opts.onMessage(errorResult("A turn is already running."));
      return;
    }
    this.turnActive = true;
    this.abortController = new AbortController();
    const controller = this.abortController;
    const before = this.loop?.messages.length ?? 0;
    const todosAtStart = this.todos;
    if (this.runDeadline !== undefined) {
      const remaining = Math.max(0, this.runDeadline - Date.now());
      this.timeoutTimer = setTimeout(() => {
        controller.abort(new RunLimitError("timeoutMs", this.opts.runLimits?.timeoutMs ?? remaining));
      }, remaining);
    }
    let cancelledBeforeStart = false;
    this.cancelPendingStart = () => {
      if (cancelledBeforeStart) return;
      cancelledBeforeStart = true;
      this.opts.onMessage({ type: "result", subtype: "success", duration_ms: 0 });
    };
    void (async () => {
      try {
        await (this.mcpReady ?? Promise.resolve());
        this.cancelPendingStart = undefined;
        if (this.disposed || cancelledBeforeStart) {
          this.turnActive = false;
          return;
        }
        if (controller.signal.aborted) {
          this.opts.onMessage({ type: "result", subtype: "success", duration_ms: 0 });
          this.turnActive = false;
          return;
        }
        await this.hooksRunner?.run("UserPromptSubmit", { promptLength: text.length });
        this.changes?.beginCheckpoint();
        try {
          await this.loop?.runTurn(text, controller.signal, images);
          const added = this.loop?.messages.slice(before) ?? [];
          for (const entry of added) this.sessionFile?.append(entry);
          if (this.sessionFile && this.todos !== todosAtStart) {
            this.sessionFile.append({ type: "todos", todos: this.todos });
          }
          this.maybeExtractMemories();
        } finally {
          if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
          this.timeoutTimer = undefined;
          this.changes?.finishCheckpoint();
          this.turnActive = false;
        }
      } catch (err) {
        if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
        this.timeoutTimer = undefined;
        this.turnActive = false;
        // runTurn never rejects; this guards checkpoint/session persistence
        // failures from becoming an unhandled rejection that kills the process.
        this.opts.onMessage(errorResult(
          `Failed to save session changes: ${err instanceof Error ? err.message : String(err)}`
        ));
      }
    })();
  }

  async ready(): Promise<void> {
    const pending = this.mcpReady ?? Promise.resolve();
    if (this.runDeadline === undefined || this.opts.runLimits?.timeoutMs === undefined) return pending;
    const remaining = this.runDeadline - Date.now();
    if (remaining <= 0) {
      this.opts.onMessage(limitMessage("timeoutMs", this.opts.runLimits.timeoutMs));
      throw new RunLimitError("timeoutMs", this.opts.runLimits.timeoutMs);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RunLimitError("timeoutMs", this.opts.runLimits?.timeoutMs ?? remaining)), remaining);
        })
      ]);
    } catch (err) {
      if (err instanceof RunLimitError) this.opts.onMessage(limitMessage(err.limit, err.value));
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  async interrupt(reason?: unknown): Promise<void> {
    this.abortController?.abort(reason);
    this.cancelPendingStart?.();
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

  changeSummaries(latestOnly = false): ChangeSummary[] {
    return this.changes?.listChanges(latestOnly) ?? [];
  }

  changeDiff(path?: string): { content: string; truncated: boolean } {
    return this.changes?.diff(path) ?? { content: "No session-owned changes.", truncated: false };
  }

  previewUndo(): UndoPreview {
    return this.changes?.previewUndo() ?? { operations: [], conflicts: [] };
  }

  undoLatest(): UndoResult {
    if (this.turnActive) {
      return { applied: false, operations: [], conflicts: ["A turn is currently running."], rollbackErrors: [] };
    }
    return this.changes?.undoLatest() ?? { applied: false, operations: [], conflicts: [], rollbackErrors: [] };
  }

  isTurnActive(): boolean {
    return this.turnActive;
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
    this.disposed = true;
    this.cancelPendingStart = undefined;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    this.abortController?.abort();
    await this.hooksRunner?.run("SessionEnd").catch(() => {});
    await this.bgShells?.killAll();
    await this.mcp.dispose();
    this.lsp.shutdown();
  }
}
