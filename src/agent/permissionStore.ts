import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  tool: string;
  decision: PermissionDecision;
  // Exactly one of the following is set: `dir` for path rules,
  // `prefix` for Bash command rules (matched on the first token),
  // `host` for WebFetch host rules.
  dir?: string;
  prefix?: string;
  host?: string;
}

// Case folding is Windows-only on purpose: on a case-sensitive filesystem
// "/srv/App" and "/srv/app" are different directories, so lowercasing there
// would let an allow-rule for one silently cover the other.
// Shared with agent/networkStorage.ts so tool paths and network targets are
// normalized identically (resolve + forward slashes + win32 case folding).
export function normalizePath(p: string): string {
  const normalized = resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isValidRule(r: unknown): r is PermissionRule {
  const rule = r as PermissionRule;
  const scopeCount = [rule.dir, rule.prefix, rule.host]
    .filter(value => typeof value === "string").length;
  return (
    !!rule &&
    typeof rule.tool === "string" &&
    (rule.decision === "allow" || rule.decision === "deny") &&
    scopeCount === 1
  );
}

// First whitespace-delimited token of a command, used as the remembered
// prefix (e.g. "git status --short" -> "git").
export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

// Detects shell control/chaining operators that let a command string run
// more than the literal command a remembered prefix rule was approved for.
// bash.ts hands the whole command string to a real shell (`sh -c` / `powershell -Command`),
// so "git status; rm -rf ~" has a commandPrefix of "git" but actually runs
// two commands. Any of these operators means the "first token" is no longer
// a trustworthy proxy for "what this command does", so callers must treat
// the command as ineligible for the allow-prefix fast path.
//
// The character class covers `;`, `&` (both `&&` and a bare background/chain
// `&`), `|` (both `||` and a pipe), a backtick, and `<`/`>` redirections; the
// `\n`/`\r` catch a newline-injected second line ("git status\nrm -rf ~"),
// which both sh and PowerShell execute as a separate statement even though its
// commandPrefix is still "git"; the `\$\(` catches command substitution. A tab
// is deliberately excluded — it is argument whitespace, not a separator.
const COMPOUND_COMMAND_PATTERN = /[;&|`\n\r<>]|\$\(/;

export function isCompoundCommand(command: string): boolean {
  return COMPOUND_COMMAND_PATTERN.test(command);
}

export class PermissionStore {
  private rules: PermissionRule[] = [];
  private filePath: string;

  constructor(cwd: string) {
    this.filePath = join(cwd, ".cloudcode", "permissions.json");
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.rules = raw.filter(isValidRule);
    } catch {
      // missing or invalid file: start empty
    }
  }

  check(tool: string, filePath: string): PermissionDecision | undefined {
    const file = normalizePath(filePath);
    const matches = this.rules.filter(r => {
      if (r.tool !== tool || r.dir === undefined) return false;
      const dir = normalizePath(r.dir);
      return file === dir || file.startsWith(dir + "/");
    });
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }

  /** Scopes the rule to the directory containing `filePath`. */
  remember(tool: string, filePath: string, decision: PermissionDecision): void {
    this.rememberDir(tool, dirname(resolve(filePath)), decision);
  }

  /**
   * Scopes the rule to `dir` itself. Glob/Grep take a directory to search
   * rather than a file inside one, so taking their dirname would widen the
   * rule to the parent of what the user actually approved.
   */
  rememberDir(tool: string, dir: string, decision: PermissionDecision): void {
    const normalized = normalizePath(dir);
    this.rules = this.rules.filter(r => !(r.tool === tool && r.dir !== undefined && normalizePath(r.dir) === normalized));
    this.rules.push({ tool, dir: normalized, decision });
    // The in-memory rule applies even if persisting fails; the caller reports
    // the failure to the user.
    this.persist();
  }

  // Prefix rules are case-insensitive: Windows shells treat command names
  // case-insensitively and the store already lowercases paths.
  checkCommand(command: string): PermissionDecision | undefined {
    const first = commandPrefix(command).toLowerCase();
    if (first === "") return undefined;
    const matches = this.rules.filter(
      r => r.tool === "Bash" && r.prefix !== undefined && r.prefix.toLowerCase() === first
    );
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }

  rememberCommand(prefix: string, decision: PermissionDecision): void {
    const p = prefix.toLowerCase();
    this.rules = this.rules.filter(r => !(r.tool === "Bash" && r.prefix?.toLowerCase() === p));
    // Store the prefix as typed (for display in /permissions list) while
    // matching stays case-insensitive via checkCommand's .toLowerCase() calls.
    this.rules.push({ tool: "Bash", prefix, decision });
    this.persist();
  }

  checkHost(tool: string, host: string): PermissionDecision | undefined {
    const key = host.toLowerCase();
    const matches = this.rules.filter(
      r => r.tool === tool && r.host !== undefined && r.host.toLowerCase() === key
    );
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }

  rememberHost(tool: string, host: string, decision: PermissionDecision): void {
    const key = host.toLowerCase();
    this.rules = this.rules.filter(r => !(r.tool === tool && r.host?.toLowerCase() === key));
    // Store the host as typed (for display in /permissions list) while
    // matching stays case-insensitive via checkHost's toLowerCase calls.
    this.rules.push({ tool, host, decision });
    this.persist();
  }

  list(): PermissionRule[] {
    return [...this.rules];
  }

  clear(): void {
    this.rules = [];
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2));
  }
}
