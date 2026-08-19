import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import { resolvePackContributions } from "./packs.js";

export type McpServerConfig = Record<string, unknown>;

export function mcpHttpDestination(config: McpServerConfig): string | undefined {
  if (typeof config.url === "string") return config.url;
  const transport = config.transport;
  if (transport && typeof transport === "object" && !Array.isArray(transport)) {
    const value = (transport as Record<string, unknown>).url;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export interface McpServerStatusEntry {
  name: string;
  status: string;
}

export interface McpServersByScope {
  user: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
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

export function loadMcpServersByScope(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): McpServersByScope {
  return {
    user: readServerFile(userPath),
    project: readServerFile(join(cwd, ".mcp.json"))
  };
}

export function loadMcpServers(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json"),
  includeProject = true
): Record<string, McpServerConfig> {
  const scopes = loadMcpServersByScope(cwd, userPath);
  const merged = includeProject ? { ...scopes.user, ...scopes.project } : { ...scopes.user };
  if (includeProject) {
    for (const [name, config] of Object.entries(resolvePackContributions(cwd, dirname(userPath)).mcp)) {
      if (Object.hasOwn(merged, name)) throw new Error(`MCP identifier collision: ${name}.`);
      merged[name] = config;
    }
  }
  return merged;
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
