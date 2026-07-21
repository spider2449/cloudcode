import { existsSync } from "node:fs";
import { dirname, extname, join, delimiter } from "node:path";
import type { ServerConfig } from "./defaults.js";

export function detectLanguage(
  filePath: string,
  registry: Record<string, ServerConfig>
): string | undefined {
  const ext = extname(filePath).toLowerCase();
  for (const [lang, cfg] of Object.entries(registry)) {
    if (cfg.extensions.includes(ext)) return lang;
  }
  return undefined;
}

export function findRoot(filePath: string, markers: string[], fallback: string): string {
  let dir = dirname(filePath);
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

const existsCache = new Map<string, boolean>();

export function commandExists(command: string): boolean {
  const cached = existsCache.get(command);
  if (cached !== undefined) return cached;

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  let found = false;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) { found = true; break outer; }
    }
  }
  existsCache.set(command, found);
  return found;
}
