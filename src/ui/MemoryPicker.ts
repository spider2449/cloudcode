import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../agent/providers.js";
import { memoryDir } from "../engine/memoryPaths.js";

// NOTE: This file used to also contain the Ink `MemoryPicker` component; that
// component was removed when the legacy Ink TUI was deleted. `MemoryOption`
// and `buildMemoryOptions` remain because the native TUI (nativeApp.ts,
// widgets/overlay.ts) still depends on them.
export interface MemoryOption {
  label: string;
  path: string;
  kind: "file" | "folder";
}

export function buildMemoryOptions(cwd: string, base: string = configDir()): MemoryOption[] {
  const userPath = join(base, "CLOUDCODE.md");
  const projectPath = join(cwd, "CLAUDE.md");
  const suffix = (p: string) => (existsSync(p) ? "" : " (new)");
  return [
    { label: `User memory${suffix(userPath)}`, path: userPath, kind: "file" },
    { label: `Project memory${suffix(projectPath)}`, path: projectPath, kind: "file" },
    { label: "Open auto-memory folder", path: memoryDir(cwd, base), kind: "folder" }
  ];
}
