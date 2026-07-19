import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { loadSettings } from "../../agent/settings.js";

// Read-only report of config file locations and effective settings.
// The default model literal mirrors DEFAULT_MODEL in agent/session.ts.
export function configReport(dir: string = configDir()): string {
  const s = loadSettings(join(dir, "settings.json"));
  return [
    "Config files:",
    `  settings:  ${join(dir, "settings.json")}`,
    `  providers: ${join(dir, "providers.json")}`,
    `  mcp:       ${join(dir, "mcp.json")}`,
    "",
    "Effective settings:",
    `  provider:        ${s.provider ?? "anthropic (default)"}`,
    `  model:           ${s.model ?? "claude-sonnet-5 (default)"}`,
    `  permissionMode:  ${s.permissionMode ?? "default"}`,
    `  effort:          ${s.effort ?? "off"}`,
    `  theme:           ${s.theme ?? "dark (default)"}`,
    `  autoMemory:      ${s.autoMemoryEnabled === false ? "disabled" : "enabled"}`
  ].join("\n");
}
