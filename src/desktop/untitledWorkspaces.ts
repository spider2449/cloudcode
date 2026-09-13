import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../agent/providers.js";

const FILE_NAME = "desktop-untitled-workspaces.json";
const MAX_ENTRIES = 20;

// Member directories of not-yet-saved multi-repo workspaces, keyed by
// workspace id. File-backed workspaces persist via their .code-workspace
// file instead, so only unsaved ones live here. Same tolerant loader pattern
// as workspaceIds.ts: missing or malformed state starts empty.
export function loadUntitledWorkspaces(
  filePath: string = join(configDir(), FILE_NAME)
): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [id, dirs] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(dirs)) continue;
      const members = dirs.filter((dir): dir is string => typeof dir === "string" && dir !== "");
      if (members.length > 0) out[id] = members;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveUntitledWorkspace(
  id: string,
  dirs: string[],
  filePath: string = join(configDir(), FILE_NAME)
): void {
  const all = { [id]: dirs, ...loadUntitledWorkspaces(filePath) };
  const pruned = Object.fromEntries(Object.entries(all).slice(0, MAX_ENTRIES));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(pruned, null, 2));
}

export function removeUntitledWorkspace(
  id: string,
  filePath: string = join(configDir(), FILE_NAME)
): void {
  const all = loadUntitledWorkspaces(filePath);
  if (!(id in all)) return;
  delete all[id];
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(all, null, 2));
}
