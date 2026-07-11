import { randomUUID } from "node:crypto";
import type { EngineMessage } from "../engine/messages.js";
import { EngineLoop } from "../engine/loop.js";
import { makeClient } from "../engine/api.js";
import { builtinTools } from "../engine/registry.js";
import { PermissionStore } from "./permissionStore.js";
import { SessionFile } from "../engine/sessions.js";
import { McpManager } from "../engine/mcpClient.js";
import { buildSystemPrompt } from "../engine/systemPrompt.js";
import type { ProviderConfig } from "./providers.js";
import type { McpServerConfig, McpServerStatusEntry } from "./mcp.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

const DEFAULT_MODEL = "claude-sonnet-5";

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  resolve(allow: boolean): void;
}

export interface AgentSessionOptions {
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  permissionMode: PermissionMode;
  resume?: string;
  cwd: string;
  mcpServers?: Record<string, McpServerConfig>;
  onMessage(msg: EngineMessage): void;
  onPermissionRequest(req: PermissionRequest): void;
  onSessionId(id: string): void;
}

export class AgentSession {
  private loop: EngineLoop | undefined;
  private abortController: AbortController | undefined;
  private sessionFile: SessionFile | undefined;
  sessionId: string | undefined;
  tools: string[] = [];
  private mcp = new McpManager();
  private mcpReady: Promise<void> | undefined;

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
      permissionMode: this.opts.permissionMode,
      store,
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
    });
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  async setModel(model: string): Promise<void> {
    this.loop?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.loop?.setPermissionMode(mode);
  }

  async mcpStatus(): Promise<McpServerStatusEntry[]> {
    return this.mcp.status();
  }

  async compact(): Promise<void> {
    if (!this.loop) return;
    await this.loop.compact(makeClient(this.opts.provider), this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL);
  }

  async dispose(): Promise<void> {
    this.abortController?.abort();
    await this.mcp.dispose();
  }
}
