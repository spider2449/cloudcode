export function parseSlash(input: string): { name: string; args: string } | undefined {
  const m = /^\/(\w+)\s*(.*)$/.exec(input.trim());
  if (!m) return undefined;
  return { name: m[1], args: m[2].trim() };
}
