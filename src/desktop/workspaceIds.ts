import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../agent/providers.js";

const FILE_NAME = "desktop-workspace-ids.json";
const MAX_ENTRIES = 50;

// Stable workspace ids across app restarts. The renderer's remembered
// selection matches workspaces by id, so ids must survive the process that
// minted them; the in-memory roots map in DesktopShellHost cannot do that.
export function loadWorkspaceIds(
  filePath: string = join(configDir(), FILE_NAME)
): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const entries = Object.entries(value as Record<string, unknown>);
    const ids: Record<string, string> = {};
    for (const [cwd, id] of entries) {
      if (typeof id === "string" && id !== "") ids[cwd] = id;
    }
    return ids;
  } catch {
    // Missing or malformed state starts with no remembered ids.
    return {};
  }
}

export function saveWorkspaceId(
  cwd: string,
  id: string,
  filePath: string = join(configDir(), FILE_NAME)
): void {
  const ids = { [cwd]: id, ...loadWorkspaceIds(filePath) };
  const pruned = Object.fromEntries(Object.entries(ids).slice(0, MAX_ENTRIES));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(pruned, null, 2));
}
