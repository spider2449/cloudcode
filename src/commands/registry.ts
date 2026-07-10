import type { Command } from "./types.js";

export function parseSlash(input: string): { name: string; args: string } | undefined {
  const m = /^\/(\w+)\s*(.*)$/.exec(input.trim());
  if (!m) return undefined;
  return { name: m[1], args: m[2].trim() };
}

export function completions(registry: Map<string, Command>, prefix: string): string[] {
  return [...registry.keys()].filter(n => n.startsWith(prefix)).sort();
}
