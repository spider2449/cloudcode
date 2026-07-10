import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./asyncQueue.js";
import { providerEnv, type ProviderConfig } from "./providers.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

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
  onMessage(msg: SDKMessage): void;
  onPermissionRequest(req: PermissionRequest): void;
  onSessionId(id: string): void;
  queryFn?: typeof query;
}

export class AgentSession {
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query | undefined;
  sessionId: string | undefined;

  constructor(private opts: AgentSessionOptions) {}

  start(): void {
    const queryFn = this.opts.queryFn ?? query;
    this.q = queryFn({
      prompt: this.input as AsyncIterable<SDKUserMessage>,
      options: {
        model: this.opts.model ?? this.opts.provider.model,
        permissionMode: this.opts.permissionMode,
        resume: this.opts.resume,
        cwd: this.opts.cwd,
        env: { ...process.env, ...providerEnv(this.opts.provider) },
        canUseTool: (toolName, input) =>
          new Promise(resolvePermission => {
            this.opts.onPermissionRequest({
              toolName,
              input: input as Record<string, unknown>,
              resolve: allow =>
                resolvePermission(
                  allow
                    ? { behavior: "allow", updatedInput: input }
                    : { behavior: "deny", message: "User denied this tool use" }
                )
            });
          })
      }
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q!) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this.sessionId = (msg as { session_id: string }).session_id;
          this.opts.onSessionId(this.sessionId);
        }
        this.opts.onMessage(msg);
      }
    } catch (err) {
      this.opts.onMessage({
        type: "result",
        subtype: "error_during_execution",
        result: String(err)
      } as unknown as SDKMessage);
    }
  }

  send(text: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? ""
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  async dispose(): Promise<void> {
    this.input.close();
    try {
      await this.q?.interrupt();
    } catch {
      // ignore errors during teardown
    }
  }
}
