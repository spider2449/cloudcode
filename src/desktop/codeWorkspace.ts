import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface ResolvedWorkspaceRepo {
  id: string;
  name: string;
  cwd: string;
  missing: boolean;
}

// Parse a VS Code .code-workspace file into repo entries. Relative folder
// paths resolve against the workspace file's own directory. Duplicate cwds
// collapse; unreadable JSON or a missing folders array throws.
export function parseCodeWorkspaceFile(
  filePath: string,
  text: string,
  exists: (p: string) => boolean = existsSync
): ResolvedWorkspaceRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid workspace file.");
  }
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders) || folders.length === 0) throw new Error("Invalid workspace file.");
  const base = dirname(filePath);
  const seen = new Set<string>();
  const repos: ResolvedWorkspaceRepo[] = [];
  folders.forEach((folder, index) => {
    const entry = folder as { path?: unknown; name?: unknown };
    if (typeof entry.path !== "string" || entry.path === "") return;
    let cwd = resolve(base, entry.path);
    if (process.platform === "win32") cwd = cwd.toLowerCase();
    if (seen.has(cwd)) return;
    seen.add(cwd);
    const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : basename(cwd) || cwd;
    repos.push({ id: `repo-${index}`, name, cwd, missing: !exists(cwd) });
  });
  return repos;
}
