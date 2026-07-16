import { readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED = new Set(["node_modules", "dist"]);
const MAX_ENTRIES = 5000;

export class FileIndex {
  private cache?: string[];

  constructor(private root: string) {}

  list(): string[] {
    if (!this.cache) this.cache = this.walk();
    return this.cache;
  }

  refresh(): void {
    this.cache = undefined;
  }

  private walk(): string[] {
    const out: string[] = [];
    const stack = [""];
    while (stack.length > 0 && out.length < MAX_ENTRIES) {
      const rel = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(join(this.root, rel), { withFileTypes: true });
      } catch {
        continue; // unreadable dir: skip silently
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) stack.push(childRel);
        else if (e.isFile()) out.push(childRel);
        if (out.length >= MAX_ENTRIES) break;
      }
    }
    return out;
  }
}

function isSubsequence(token: string, path: string): boolean {
  let i = 0;
  const lower = path.toLowerCase();
  for (const ch of token.toLowerCase()) {
    i = lower.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

export function fuzzyFilter(paths: string[], token: string, limit = 10): string[] {
  const basenamePrefix = (p: string) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    return base.startsWith(token.toLowerCase()) ? 0 : 1;
  };
  return paths
    .filter(p => isSubsequence(token, p))
    .sort((a, b) =>
      basenamePrefix(a) - basenamePrefix(b) ||
      a.length - b.length ||
      a.localeCompare(b)
    )
    .slice(0, limit);
}
