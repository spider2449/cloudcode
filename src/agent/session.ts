import { randomUUID } from "node:crypto";
import type { EngineMessage } from "../engine/messages.js";
import { EngineLoop } from "../engine/loop.js";
import { makeClient } from "../engine/api.js";
import { builtinTools } from "../engine/registry.js";
import { PermissionStore } from "./permissionStore.js";
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
  sessionId: string | undefined;
  tools: string[] = [];

  constructor(private opts: AgentSessionOptions) {}

  start(): void {
    this.sessionId = this.opts.resume ?? randomUUID();
    const store = new PermissionStore(this.opts.cwd);
    this.loop = new EngineLoop({
      client: makeClient(this.opts.provider),
      model: this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      systemPrompt: "You are cloudcode, an interactive terminal coding agent. Working directory: " + this.opts.cwd,
      tools: builtinTools(),
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      store,
      onMessage: this.opts.onMessage,
      requestPermission: (toolName, input) =>
        new Promise(resolve => this.opts.onPermissionRequest({ toolName, input, resolve }))
    });
    this.tools = builtinTools().map(t => t.name);
    this.opts.onSessionId(this.sessionId);
    this.opts.onMessage({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      tools: this.tools
    });
  }

  send(text: string): void {
    this.abortController = new AbortController();
    void this.loop?.runTurn(text, this.abortController.signal);
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
    return [];
  }

  async dispose(): Promise<void> {
    this.abortController?.abort();
  }
}
