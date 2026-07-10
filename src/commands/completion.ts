import type { Command } from "./types.js";
import { fuzzyFilter } from "./fileIndex.js";

export interface Suggestion {
  value: string;
  label: string;
  description?: string;
  replaceStart: number;
  replaceEnd: number;
}

export interface CompletionContext {
  registry: Map<string, Command>;
  providerNames(): string[];
  listFiles(): string[];
  refreshFiles?(): void;
}

function commandNameSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  const m = /^\/([\w-]*)$/.exec(text);
  if (!m || cursor !== text.length) return [];
  return [...ctx.registry.values()]
    .filter(c => c.name.startsWith(m[1]))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({
      value: `/${c.name} `,
      label: `/${c.name}`,
      description: c.description,
      replaceStart: 0,
      replaceEnd: text.length
    }));
}

function argumentSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  const m = /^\/([\w-]+)\s+/.exec(text);
  if (!m || cursor !== text.length) return [];
  const cmd = ctx.registry.get(m[1]);
  if (!cmd?.completeArgs) return [];
  const argStart = m[0].length;
  const prefix = text.slice(argStart, cursor);
  return cmd.completeArgs(prefix, ctx).map(v => ({
    value: v,
    label: v,
    replaceStart: argStart,
    replaceEnd: cursor
  }));
}

function fileSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  // @token immediately before the cursor; @ must be at start or after whitespace
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([\w./-]*)$/.exec(before);
  if (!m) return [];
  const atStart = m.index + m[1].length;
  return fuzzyFilter(ctx.listFiles(), m[2]).map(p => ({
    value: `@${p}`,
    label: p,
    replaceStart: atStart,
    replaceEnd: cursor
  }));
}

const PROVIDERS = [fileSuggestions, argumentSuggestions, commandNameSuggestions];

export function getSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  for (const provider of PROVIDERS) {
    const result = provider(text, cursor, ctx);
    if (result.length > 0) return result;
  }
  return [];
}

export function applySuggestion(text: string, s: Suggestion): { text: string; cursor: number } {
  const next = text.slice(0, s.replaceStart) + s.value + text.slice(s.replaceEnd);
  return { text: next, cursor: s.replaceStart + s.value.length };
}
