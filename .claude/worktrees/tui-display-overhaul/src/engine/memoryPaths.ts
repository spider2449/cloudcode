import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { configDir } from "../agent/providers.js";

// Turn an absolute project path into a stable directory-name-safe key.
export function sanitizePath(p: string): string {
  return p.replace(/[\\/:*?"<>|\s]/g, "-");
}

// cwd must be a real absolute path: a bare string like "-p" or "--repo"
// (e.g. a misrouted CLI flag) sanitizes to itself unchanged (no separators
// to replace) and would otherwise silently create a bogus project directory
// under ~/.cloudcode/projects/.
export function memoryDir(cwd: string, base: string = configDir()): string {
  if (!isAbsolute(cwd)) throw new Error(`memoryDir: cwd must be an absolute path, got ${JSON.stringify(cwd)}`);
  return join(base, "projects", sanitizePath(cwd), "memory");
}

export function memoryEntrypoint(cwd: string, base: string = configDir()): string {
  return join(memoryDir(cwd, base), "MEMORY.md");
}

// True only for paths strictly inside the memory directory (not the dir itself).
// Resolves both sides first so ".." segments cannot escape.
export function isInsideMemoryDir(candidate: string, dir: string): boolean {
  const root = resolve(dir);
  const target = resolve(candidate);
  return target !== root && target.startsWith(root + sep);
}

// Create the memory directory (recursive, EEXIST-safe). Returns false on
// failure (e.g. permissions) so callers can skip the memory section.
export function ensureMemoryDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
