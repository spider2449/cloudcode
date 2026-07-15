import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Create the file if missing without touching existing content (wx flag).
export function ensureFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

// Open a file in the user's editor, blocking until it closes.
// Returns a hint describing which editor was used.
export function openInEditor(path: string): { ok: boolean; hint: string } {
  ensureFile(path);
  const editor = process.env.VISUAL || process.env.EDITOR
    || (process.platform === "win32" ? "notepad" : "nano");
  const source = process.env.VISUAL ? "$VISUAL" : process.env.EDITOR ? "$EDITOR" : "default";
  const result = spawnSync(editor, [path], { stdio: "inherit", shell: true });
  if (result.error) return { ok: false, hint: `Failed to launch ${editor}: ${result.error.message}` };
  return {
    ok: true,
    hint: source === "default"
      ? `Opened in ${editor}. Set $EDITOR or $VISUAL to use a different editor.`
      : `Opened with ${source}=${editor}.`
  };
}

// Open a folder in the platform file manager (fire-and-forget).
export function openFolder(path: string): void {
  const cmd = process.platform === "win32" ? "explorer"
    : process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(cmd, [path], { stdio: "ignore", shell: process.platform === "win32" });
}
