import { isAbsolute, join, resolve, sep } from "node:path";
import type { PermissionMode } from "../agent/session.js";
import { type PermissionStore, isCompoundCommand } from "../agent/permissionStore.js";
import { matchNetworkStorage, networkRememberTargetForPath, type NetworkStorageRule } from "../agent/networkStorage.js";
import { memoryDir, userMemoryFile } from "./memoryPaths.js";
import { configDir } from "../agent/providers.js";
import { homedir } from "node:os";

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
 * The host a remembered WebFetch/WebSearch rule would be matched against,
 * or undefined for anything else. Kept separate from RuleScope because hosts
 * have no path component: the controller stores them via rememberHost,
 * not rememberDir. WebSearch always scopes to the search endpoint host.
 */
export function hostScope(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "WebSearch") return "html.duckduckgo.com";
  if (toolName !== "WebFetch" || typeof input.url !== "string") return undefined;
  try {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The network-storage root a remembered rule for this tool call would be
 * written into global settings for, or undefined when the call does not name
 * a network path outside cwd (those are remembered as project dir rules as
 * before). Kept beside ruleScope/hostScope so the overlay's remember answer
 * and the decider agree on scoping.
 */
export function networkRememberTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string | undefined {
  const scope = ruleScope(toolName, input);
  if (!scope || isInsideCwd(scope.path, cwd)) return undefined;
  return networkRememberTargetForPath(scope.path);
}

// True for paths at or inside `cwd`. Resolves both sides first so ".."
// segments and relative paths can't produce a false "inside" result.
function isInsideCwd(filePath: string, cwd: string): boolean {
  const root = resolve(cwd);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return target === root || target.startsWith(root + sep);
}

export type PathClass = "inside" | "owned" | "networkAllow" | "sensitive" | "outside";

/**
 * Single policy gate for path confinement. Pure: resolves paths, reads no
 * disk. Precedence mirrors the old inline checks exactly: inside-cwd wins
 * first (a project-local file is never "sensitive"), then the two
 * credential files, then an explicit network allow, then the
 * cloudcode-owned config/memory dirs; anything else is outside.
 *
 * The "owned" branch covers cloudcode's own workspace under the user config
 * dir (~/.cloudcode): sessions, skills, tasks, maintenance, audit, and the
 * project/user memory files. All live outside cwd by construction, so
 * without this exemption every program file access would force an "ask" —
 * yet this dir is cloudcode's own workspace, not the rest of the
 * filesystem the confinement exists to protect. Owned paths otherwise
 * follow normal mode logic exactly like inside-cwd paths. Sensitive
 * credential files (credentials.json, providers.json) are excluded and
 * stay confined, since auto-allowing reads of API keys and OAuth tokens
 * would widen the data-exfiltration path the cwd guard exists to close.
 */
export function classifyPath(
  rawPath: string,
  cwd: string,
  networkStorage?: readonly NetworkStorageRule[]
): PathClass {
  const expanded =
    rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
      ? join(homedir(), rawPath.slice(1))
      : rawPath;
  const root = resolve(cwd);
  const target = resolve(cwd, expanded);
  if (target === root || target.startsWith(root + sep)) return "inside";
  if (
    target === resolve(configDir(), "credentials.json") ||
    target === resolve(configDir(), "providers.json")
  ) {
    return "sensitive";
  }
  if (
    networkStorage !== undefined &&
    networkStorage.length > 0 &&
    matchNetworkStorage(networkStorage, rawPath) === "allow"
  ) {
    return "networkAllow";
  }
  const base = resolve(configDir());
  if (target === base || target.startsWith(base + sep)) return "owned";
  if (target === resolve(userMemoryFile())) return "owned";
  const mem = resolve(memoryDir(cwd));
  if (target === mem || target.startsWith(mem + sep)) return "owned";
  return "outside";
}

const BASH_PATH_PATTERNS = [
  /[A-Za-z]:[\\/][^\s"'|<>;&]*/g,
  /\\\\[^\s"'|<>;&]+/g,
  /(?:^|[\s"'=])(~(?:\/[^\s"'|<>;&]*)?|\/[^\s"'|<>;&]*)/gm,
];
const BASH_CD_RE =
  /(?:^|[;&|\n])\s*(?:cd|chdir|pushd|Set-Location)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|<>]+))/gim;
const BASH_REDIRECT_RE = /[12]?\s*>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s|<>;&]+))/g;

/**
 * Best-effort path candidates from a Bash/PowerShell command string.
 * Deliberately not a shell parser (see spec non-goals): covers absolute
 * paths, cd targets (including relative escapes like `..`), and redirect
 * targets. Each candidate is classified by the caller; non-paths that slip
 * through resolve inside cwd and are harmless.
 */
export function extractBashPaths(command: string): string[] {
  const found = new Set<string>();
  for (const re of BASH_PATH_PATTERNS) {
    for (const m of command.matchAll(re)) {
      found.add((m[1] ?? m[0]).trim().replace(/[,;:]+$/, ""));
    }
  }
  for (const re of [BASH_CD_RE, BASH_REDIRECT_RE]) {
    for (const m of command.matchAll(re)) {
      const token = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (token !== "") found.add(token);
    }
  }
  return [...found];
}

export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  store: PermissionStore,
  cwd: string,
  networkStorage?: readonly NetworkStorageRule[]
): PermissionDecision {
  // Global network-storage rules are consulted before everything else: a
  // matching deny blocks even bypassPermissions, and a matching allow lets an
  // outside-cwd network path be treated as inside-cwd for every check below
  // (so reads auto-allow, edits follow acceptEdits, bypass allows). An
  // unmatched network path falls through to the normal forced-ask behavior.
  const scope = ruleScope(toolName, input);
  if (scope && networkStorage && networkStorage.length > 0) {
    const ruling = matchNetworkStorage(networkStorage, scope.path);
    if (ruling === "deny") return "deny";
  }
  // Single gate: inside and owned/networkAllow paths are unconfined,
  // outside and sensitive paths are confined. A network allow surfaces as
  // "networkAllow" (unconfined), so no separate networkAllows flag is
  // needed; a network deny already returned above.
  const cls = scope === undefined ? undefined : classifyPath(scope.path, cwd, networkStorage);
  const confined = cls === "outside" || cls === "sensitive";
  // acceptEdits/bypassPermissions auto-allow edits, but only inside cwd — a
  // write outside cwd always needs an explicit human "ask" (or a remembered
  // store rule, checked below), since those modes otherwise remove the only
  // barrier between model output and the rest of the filesystem.
  const outsideCwdFile = typeof input.file_path === "string" && confined;
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
    SEARCH_TOOLS.has(toolName) && typeof input.path === "string" && confined;
  // Bash names no path input, so ruleScope is undefined for it: extract
  // candidate paths from the command string and confine them like any
  // other path. A matching Bash dir-rule allow exempts a path (the store
  // stays the sole allow authority); prefix-deny already returned above.
  const bashPaths =
    toolName === "Bash" && typeof input.command === "string" ? extractBashPaths(input.command) : [];
  const bashOutside = bashPaths.some(path => {
    const c = classifyPath(path, cwd, networkStorage);
    if (c !== "outside" && c !== "sensitive") return false;
    return store.check("Bash", path) !== "allow";
  });

  if (mode === "bypassPermissions" && !outsideCwdEdit && !outsideCwdRead && !outsideCwdSearch && !bashOutside) return "allow";
  // Per-directory rules (deny beats allow) apply to every tool that names a
  // path, keyed on the input that tool actually takes.
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
    if (ruling === "allow" && !compound && !bashOutside) return "allow";
  }
  // A Bash command reaching an outside/sensitive path with no covering
  // allow rule always asks — in default/acceptEdits this matches the
  // existing fallthrough, in bypassPermissions it closes the escape hatch.
  // A prefix deny already returned "deny" above and is never softened here.
  if (toolName === "Bash" && bashOutside) return "ask";
  // Remembered host rules for WebFetch/WebSearch (deny beats allow), then
  // always ask — both are outbound network access, never unconditionally allowed.
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const host = hostScope(toolName, input);
    if (host) {
      const ruling = store.checkHost(toolName, host);
      if (ruling) return ruling;
    }
    return "ask";
  }
  // Task dispatches a read-only exploration subagent in its own context
  // window. The subagent's inner reads stay gated by this same decider, so
  // prompting at dispatch only adds friction that pushes broad reviews back
  // into the main context. Always allow, like TodoWrite.
  if (toolName === "Task") return "allow";
  // TodoWrite only mutates the session's internal checklist — nothing on
  // disk, nothing outbound — so it never needs a prompt in any mode.
  if (toolName === "TodoWrite") return "allow";
  // BashOutput/KillShell only touch state from an already-approved background
  // command, so they never prompt in any mode.
  if (toolName === "BashOutput" || toolName === "KillShell") return "allow";
  if (READ_ONLY.has(toolName)) return outsideCwdRead || outsideCwdSearch ? "ask" : "allow";
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return outsideCwdEdit ? "ask" : "allow";
  return "ask";
}
