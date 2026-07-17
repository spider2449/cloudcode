import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  tool: string;
  decision: PermissionDecision;
  // Exactly one of the following is set: `dir` for file-path rules,
  // `prefix` for Bash command rules (matched on the first token).
  dir?: string;
  prefix?: string;
}

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

function isValidRule(r: unknown): r is PermissionRule {
  const rule = r as PermissionRule;
  return (
    !!rule &&
    typeof rule.tool === "string" &&
    (rule.decision === "allow" || rule.decision === "deny") &&
    (typeof rule.dir === "string") !== (typeof rule.prefix === "string")
  );
}

// First whitespace-delimited token of a command, used as the remembered
// prefix (e.g. "git status --short" -> "git").
export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
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

  remember(tool: string, filePath: string, decision: PermissionDecision): void {
    const dir = normalizePath(dirname(resolve(filePath)));
    this.rules = this.rules.filter(r => !(r.tool === tool && r.dir !== undefined && normalizePath(r.dir) === dir));
    this.rules.push({ tool, dir, decision });
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
    this.rules.push({ tool: "Bash", prefix: p, decision });
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
