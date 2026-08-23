import { isAbsolute, resolve, sep } from "node:path";
import type { PermissionMode } from "../agent/session.js";
import { type PermissionStore, isCompoundCommand } from "../agent/permissionStore.js";

const READ_ONLY = new Set(["Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["Write", "Edit"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
// Take a directory `path` (defaulting to cwd) rather than a `file_path`.
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);

export type PermissionDecision = "allow" | "deny" | "ask";

export interface RuleScope {
  path: string;
  /** "file": scope a remembered rule to the containing directory. "dir": the
   * path already is the directory (Glob/Grep search a directory directly). */
  kind: "file" | "dir";
}

/**
 * The path a remembered rule for this tool call would be scoped to, or
 * undefined if the tool takes none. Single source of truth for three callers:
 * the decision below, the overlay deciding whether to offer an "always for
 * this directory" answer, and the controller storing that answer. They must
 * agree, or the UI offers to remember a rule nothing ever consults.
 */
export function ruleScope(toolName: string, input: Record<string, unknown>): RuleScope | undefined {
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === "string") {
    return { path: input.file_path, kind: "file" };
  }
  if (SEARCH_TOOLS.has(toolName) && typeof input.path === "string") {
    return { path: input.path, kind: "dir" };
  }
  return undefined;
}

/**
 * The host a remembered WebFetch rule would be matched against, or undefined
 * for anything else. Kept separate from RuleScope because hosts have no path
 * component: the controller stores them via rememberHost, not rememberDir.
 */
export function hostScope(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName !== "WebFetch" || typeof input.url !== "string") return undefined;
  try {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

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
  const outsideCwdFile =
    typeof input.file_path === "string" && !isInsideCwd(input.file_path, cwd);
  const outsideCwdEdit = EDIT_TOOLS.has(toolName) && outsideCwdFile;
  // Reads are otherwise unconditionally allowed (see READ_ONLY below), but a
  // read resolving outside cwd is the primary data-exfiltration path for a
  // coding agent (e.g. ~/.ssh/id_rsa, ~/.aws/credentials) and so needs the
  // same cwd confinement as edits.
  const outsideCwdRead = toolName === "Read" && outsideCwdFile;
  // Same confinement for the search tools, which walk and read every file
  // under their `path`: unconfined, `Grep` over ~/.aws with a pattern like
  // "secret" is the same exfiltration path as a targeted Read, only broader.
  // An omitted (or empty) `path` means cwd, which is inside by definition.
  const outsideCwdSearch =
    SEARCH_TOOLS.has(toolName) && typeof input.path === "string" && !isInsideCwd(input.path, cwd);

  if (mode === "bypassPermissions" && !outsideCwdEdit && !outsideCwdRead && !outsideCwdSearch) return "allow";
  // Per-directory rules (deny beats allow) apply to every tool that names a
  // path, keyed on the input that tool actually takes.
  const scope = ruleScope(toolName, input);
  if (scope) {
    const ruling = store.check(toolName, scope.path);
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
  // Remembered host rules for WebFetch (deny beats allow), then always ask —
  // fetching is outbound network access, so it is never unconditionally allowed.
  if (toolName === "WebFetch") {
    const host = hostScope(toolName, input);
    if (host) {
      const ruling = store.checkHost(toolName, host);
      if (ruling) return ruling;
    }
    return "ask";
  }
  if (READ_ONLY.has(toolName)) return outsideCwdRead || outsideCwdSearch ? "ask" : "allow";
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return outsideCwdEdit ? "ask" : "allow";
  return "ask";
}
