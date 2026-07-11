import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SessionEntry } from "../agent/sessionIndex.js";

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string };

export function resolveProjectPath(input: string, cwd: string): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Usage: /set project <path>" };
  const expanded =
    trimmed === "~" ? homedir() :
    trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? resolve(homedir(), trimmed.slice(2)) :
    trimmed;
  const path = resolve(cwd, expanded);
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: `Not a directory: ${path}` };
  } catch {
    return { ok: false, error: `Not a directory: ${path}` };
  }
  return { ok: true, path };
}

export function recentProjects(entries: SessionEntry[], currentCwd: string): string[] {
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const cwds = [currentCwd, ...sorted.map(e => e.cwd)];
  return [...new Set(cwds)];
}
