import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";

const READ_ONLY = new Set(["Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["Write", "Edit"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

export type PermissionDecision = "allow" | "deny" | "ask";

export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  store: PermissionStore
): PermissionDecision {
  if (mode === "bypassPermissions") return "allow";
  // Per-directory rules (deny beats allow) apply to file tools.
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === "string") {
    const ruling = store.check(toolName, input.file_path);
    if (ruling === "deny") return "deny";
    if (ruling === "allow") return "allow";
  }
  if (READ_ONLY.has(toolName)) return "allow";
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return "allow";
  return "ask";
}
