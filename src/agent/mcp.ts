import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// Read-modify-write preserving unknown top-level keys, mirroring the
// loadRaw/saveSetting convention in agent/settings.ts.
function writeServerFile(filePath: string, servers: Record<string, McpServerConfig>): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or invalid file: start from an empty object
  }
  raw.mcpServers = servers;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(raw, null, 2));
}

export function saveMcpServer(
  name: string,
  config: McpServerConfig,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  servers[name] = config;
  writeServerFile(filePath, servers);
}

export function removeMcpServer(
  name: string,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  delete servers[name];
  writeServerFile(filePath, servers);
}

export function isMcpServerDisabled(config: McpServerConfig): boolean {
  return config.disabled === true;
}

export function resolveMcpServerScope(
  name: string,
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): "user" | "project" | undefined {
  const scopes = loadMcpServersByScope(cwd, userPath);
  if (Object.hasOwn(scopes.project, name)) return "project";
  if (Object.hasOwn(scopes.user, name)) return "user";
  return undefined;
}

export function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  const existing = servers[name];
  if (!existing) throw new Error(`No MCP server named "${name}".`);
  if (disabled) {
    servers[name] = { ...existing, disabled: true };
  } else {
    const next = { ...existing };
    delete next.disabled;
    servers[name] = next;
  }
  writeServerFile(filePath, servers);
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
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (isMcpServerDisabled(config)) continue;
    const next = { ...config };
    delete next.disabled;
    enabled[name] = next;
  }
  return enabled;
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
