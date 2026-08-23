import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Same token grammar as completion.ts's fileSuggestions, in global form:
// "@" at line start or after whitespace, followed by path characters.
const MENTION = /(^|\s)@([\w./-]+)/g;

export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION)) found.add(m[2]);
  return [...found];
}

export function missingMentions(text: string, cwd: string): string[] {
  return extractMentions(text).filter(p => !existsSync(resolve(cwd, p)));
}
