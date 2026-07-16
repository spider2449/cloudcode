import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";

export type McpServerConfig = Record<string, unknown>;

export interface McpServerStatusEntry {
  name: string;
  status: string;
}

function readServerFile(filePath: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const servers = raw?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, McpServerConfig>;
    }
  } catch {
    // missing or invalid file: contributes no servers
  }
  return {};
}

export function loadMcpServers(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): Record<string, McpServerConfig> {
  const user = readServerFile(userPath);
  const project = readServerFile(join(cwd, ".mcp.json"));
  return { ...user, ...project };
}

export function formatMcpStatus(
  configured: string[],
  statuses: McpServerStatusEntry[],
  tools: string[]
): string {
  if (configured.length === 0) {
    return "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json.";
  }
  const statusByName = new Map(statuses.map(s => [s.name, s.status]));
  return configured
    .map(name => {
      const status = statusByName.get(name) ?? "pending";
      const prefix = `mcp__${name}__`;
      const serverTools = tools.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length));
      const toolsPart = serverTools.length > 0 ? `  tools: ${serverTools.join(", ")}` : "";
      return `${name}  ${status}${toolsPart}`;
    })
    .join("\n");
}
