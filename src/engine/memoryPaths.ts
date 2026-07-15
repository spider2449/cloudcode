import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { configDir } from "../agent/providers.js";

// Turn an absolute project path into a stable directory-name-safe key.
export function sanitizePath(p: string): string {
  return p.replace(/[\\/:*?"<>|\s]/g, "-");
}

export function memoryDir(cwd: string, base: string = configDir()): string {
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
