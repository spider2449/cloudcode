import { isAbsolute, resolve, sep } from "node:path";
import type { PermissionMode } from "../agent/session.js";
import { type PermissionStore, isCompoundCommand } from "../agent/permissionStore.js";

const READ_ONLY = new Set(["Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["Write", "Edit"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

export type PermissionDecision = "allow" | "deny" | "ask";

// True for paths at or inside `cwd`. Resolves both sides first so ".."
// segments and relative paths can't produce a false "inside" result.
function isInsideCwd(filePath: string, cwd: string): boolean {
  const root = resolve(cwd);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return target === root || target.startsWith(root + sep);
}

export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  store: PermissionStore,
  cwd: string
): PermissionDecision {
  // acceptEdits/bypassPermissions auto-allow edits, but only inside cwd — a
  // write outside cwd always needs an explicit human "ask" (or a remembered
  // store rule, checked below), since those modes otherwise remove the only
  // barrier between model output and the rest of the filesystem.
  const outsideCwdEdit =
    EDIT_TOOLS.has(toolName) && typeof input.file_path === "string" && !isInsideCwd(input.file_path, cwd);

  if (mode === "bypassPermissions" && !outsideCwdEdit) return "allow";
  // Per-directory rules (deny beats allow) apply to file tools.
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === "string") {
    const ruling = store.check(toolName, input.file_path);
    if (ruling === "deny") return "deny";
    if (ruling === "allow") return "allow";
  }
  // Remembered command-prefix rules apply to Bash (deny beats allow).
  if (toolName === "Bash" && typeof input.command === "string") {
    const compound = isCompoundCommand(input.command);
    const ruling = store.checkCommand(input.command);
    // A matching DENY rule always wins, even for a compound command: the
    // remembered prefix is being extra cautious about, so honoring it here
    // can only make the outcome safer, never less safe.
    if (ruling === "deny") return "deny";
    // A matching ALLOW rule is only trusted for a simple, non-chained
    // command. bash.ts runs the whole string through a real shell, so a
    // prefix like "git" approved for "git status" must not silently widen
    // to approve "git status; rm -rf ~" — that's the whole bug this guards.
    if (ruling === "allow" && !compound) return "allow";
  }
  if (READ_ONLY.has(toolName)) return "allow";
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return outsideCwdEdit ? "ask" : "allow";
  return "ask";
}
