import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { loadSettings } from "../../agent/settings.js";
import { bashNetworkStatus, type NetworkMode } from "../../agent/networkPolicy.js";

// Read-only report of config file locations and effective settings.
// The default model literal mirrors DEFAULT_MODEL in agent/session.ts.
export function configReport(dir: string = configDir(), override?: NetworkMode): string {
  const s = loadSettings(join(dir, "settings.json"));
  const networkMode = override ?? s.networkMode ?? "providerOnly";
  const bash = bashNetworkStatus(networkMode, false);
  return [
    "Config files:",
    `  settings:  ${join(dir, "settings.json")}`,
    `  providers: ${join(dir, "providers.json")}`,
    `  mcp:       ${join(dir, "mcp.json")}`,
    `  checkpoints: ${join(dir, "checkpoints")}`,
    "",
    "Effective settings:",
    `  provider:        ${s.provider ?? "anthropic (default)"}`,
    `  model:           ${s.model ?? "claude-sonnet-5 (default)"}`,
    `  permissionMode:  ${s.permissionMode ?? "default"}`,
    `  networkMode:     ${networkMode}${override ? " (invocation)" : ""}`,
    `  Bash networking: ${bash.description}`,
    `  effort:          ${s.effort ?? "off"}`,
    `  theme:           ${s.theme ?? "dark (default)"}`,
    `  autoMemory:      ${s.autoMemoryEnabled === false ? "disabled" : "enabled"}`,
    "",
    "Network boundary:",
    "  Policy covers cloudcode-owned egress only. Arbitrary child-process",
    "  networking is not contained unless a verified sandbox says otherwise."
  ].join("\n");
}
