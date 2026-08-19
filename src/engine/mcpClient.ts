import type { McpServerConfig, McpServerStatusEntry } from "../agent/mcp.js";
import type { ToolDef } from "./tools/types.js";

// Minimal facade over an MCP client connection; the default factory uses
// @modelcontextprotocol/sdk Client + StdioClientTransport.
export interface McpConnection {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}

export type ConnectionFactory = (name: string, cfg: McpServerConfig) => Promise<McpConnection>;

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

async function defaultFactory(name: string, cfg: McpServerConfig): Promise<McpConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: String(cfg.command ?? ""),
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    env: (cfg.env as Record<string, string>) ?? undefined
  });
  const client = new Client({ name: "cloudcode", version: "0.1.0" });
  await client.connect(transport);
  return client as unknown as McpConnection;
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private states: McpServerStatusEntry[] = [];
  private toolDefs: ToolDef[] = [];
  private disposed = false;

  constructor(
    private factory: ConnectionFactory = defaultFactory,
    private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
  ) {}

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = this.factory(name, cfg).then(async conn => {
        try {
          const listed = await conn.listTools();
          return { conn, tools: listed.tools };
        } catch (err) {
          await conn.close().catch(() => {});
          throw err;
        }
      });
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MCP connection timed out")), this.connectTimeoutMs);
        });
        const { conn, tools } = await Promise.race([pending, timeout]);
        if (this.disposed) {
          await conn.close().catch(() => {});
          continue;
        }
        this.connections.set(name, conn);
        for (const t of tools) {
          this.toolDefs.push({
            name: `mcp__${name}__${t.name}`,
            description: t.description ?? "",
            input_schema: t.inputSchema,
            execute: async input => {
              const res = await conn.callTool({ name: t.name, arguments: input });
              const text = res.content.map(c => c.text ?? "").join("\n");
              return { content: text || "(no output)" };
            }
          });
        }
        this.states.push({ name, status: "connected" });
      } catch {
        this.states.push({ name, status: "failed" });
        void pending.then(({ conn }) => conn.close().catch(() => {})).catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  tools(): ToolDef[] {
    return this.toolDefs;
  }

  status(): McpServerStatusEntry[] {
    return this.states;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const conn of this.connections.values()) await conn.close().catch(() => {});
    this.connections.clear();
  }
}
