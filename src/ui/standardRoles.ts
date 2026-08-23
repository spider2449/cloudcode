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

/** Returns the theme map extended with the standard derivation for every
 * key it does not already declare. Explicit keys always win; the input is
 * not mutated. */
export function withStandardRoles(theme: Record<string, ColorValue>): Record<string, ColorValue> {
  const out = { ...theme };
  for (const [key, value] of Object.entries(STANDARD_ROLES)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}
