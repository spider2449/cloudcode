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

  constructor(private factory: ConnectionFactory = defaultFactory) {}

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const conn = await this.factory(name, cfg);
        this.connections.set(name, conn);
        const { tools } = await conn.listTools();
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
    for (const conn of this.connections.values()) await conn.close().catch(() => {});
    this.connections.clear();
  }
}
