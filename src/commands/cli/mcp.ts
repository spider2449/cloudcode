import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import {
  isMcpServerDisabled,
  loadMcpServersByScope,
  resolveMcpServerScope,
  setMcpServerDisabled
} from "../../agent/mcp.js";
import { formatMcpList } from "./mcpList.js";

export interface McpCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const USAGE = "Usage: cloudcode mcp [disable|enable <name>] [--scope user|project]";

// Parse ["disable"|"enable", name, ("--scope", scope)?]. Returns undefined
// for the bare list form; throws Error(USAGE) on bad input.
function parseToggle(args: string[]): { enable: boolean; name: string; scope?: "user" | "project" } | undefined {
  if (args.length === 0) return undefined;
  const [action, name, flag, scope] = args;
  if ((action !== "disable" && action !== "enable") || !name) throw new Error(USAGE);
  if (flag === undefined) return { enable: action === "enable", name };
  if (flag !== "--scope" || (scope !== "user" && scope !== "project")) throw new Error(USAGE);
  if (args.length !== 4) throw new Error(USAGE);
  return { enable: action === "enable", name, scope };
}

export function runMcpCommand(
  args: string[],
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): McpCommandResult {
  let toggle: { enable: boolean; name: string; scope?: "user" | "project" } | undefined;
  try {
    toggle = parseToggle(args);
  } catch (err) {
    return { exitCode: 1, stdout: err instanceof Error ? err.message : USAGE };
  }
  if (!toggle) return { exitCode: 0, stdout: formatMcpList(loadMcpServersByScope(cwd, userPath)) };
  const scope = toggle.scope ?? resolveMcpServerScope(toggle.name, cwd, userPath);
  if (!scope) return { exitCode: 1, stdout: `No MCP server named "${toggle.name}".` };
  if (scope === "project" && toggle.name.startsWith("pack__")) {
    return { exitCode: 1, stdout: `Pack servers cannot be disabled (${toggle.name}).` };
  }
  const scopes = loadMcpServersByScope(cwd, userPath);
  const current = scopes[scope][toggle.name];
  if (current && isMcpServerDisabled(current) === !toggle.enable) {
    // Already in the requested state: confirm without rewriting.
    const state = toggle.enable ? "enabled" : "disabled";
    return { exitCode: 0, stdout: `${toggle.name} is already ${state} (${scope}).` };
  }
  try {
    setMcpServerDisabled(toggle.name, !toggle.enable, scope, cwd, userPath);
  } catch (err) {
    return { exitCode: 1, stdout: err instanceof Error ? err.message : String(err) };
  }
  const verb = toggle.enable ? "Enabled" : "Disabled";
  return { exitCode: 0, stdout: `${verb} ${toggle.name} (${scope}). Restart or /clear to take effect.` };
}
