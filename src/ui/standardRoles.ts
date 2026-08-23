import type { ColorValue } from "./themeJson.js";

/**
 * Standard mapping from a theme's core roles onto the mechanical roles.
 * Each value is expressed as references so the existing resolver handles
 * def indirection and mode selection. Evidence: across the 13 builtins,
 * both mode values equal the referenced core role in at least 7 of 13
 * themes; weaker patterns stay explicit per theme.
 */
export const STANDARD_ROLES: Record<string, ColorValue> = {
  diffAdded: { dark: "success", light: "success" },
  diffRemoved: { dark: "error", light: "error" },
  diffContext: { dark: "textMuted", light: "textMuted" },
  diffContextBg: { dark: "backgroundPanel", light: "backgroundPanel" },
  diffHighlightAdded: { dark: "success", light: "success" },
  diffHighlightRemoved: { dark: "error", light: "error" },
  markdownBlockQuote: { dark: "textMuted", light: "textMuted" },
  markdownCode: { dark: "success", light: "success" },
  markdownCodeBlock: { dark: "text", light: "text" },
  markdownEmph: { dark: "warning", light: "warning" },
  markdownListEnumeration: { dark: "accent", light: "accent" },
  markdownListItem: { dark: "primary", light: "primary" },
  markdownText: { dark: "text", light: "text" },
  syntaxComment: { dark: "textMuted", light: "textMuted" },
  syntaxPunctuation: { dark: "text", light: "text" }
};
// 15 entries — must match tests/standardRoles.test.ts's expected key list.

function references(value: ColorValue): string[] {
  const out: string[] = [];
  const walk = (v: ColorValue): void => {
    if (typeof v === "object" && v !== null) { walk(v.dark); walk(v.light); }
    else if (typeof v === "string") out.push(v);
  };
  walk(value);
  return out;
}

/** Returns the theme map extended with the standard derivation for every
 * key it does not already declare. Explicit keys always win; a derivation
 * whose references cannot resolve anywhere in the theme (defs or map) is
 * skipped rather than creating a dangling reference. The input is not
 * mutated. */
export function withStandardRoles(
  theme: Record<string, ColorValue>,
  defs?: Record<string, ColorValue>
): Record<string, ColorValue> {
  const out = { ...theme };
  const available = new Set([...Object.keys(theme), ...Object.keys(defs ?? {})]);
  for (const [key, value] of Object.entries(STANDARD_ROLES)) {
    if (out[key] !== undefined) continue;
    if (!references(value).every(ref => available.has(ref))) continue;
    out[key] = value;
  }
  return out;
}
