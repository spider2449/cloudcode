import { isAbsolute, resolve } from "node:path";

/** Resolve a tool file path exactly once against the active project. */
export function resolveToolFilePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
