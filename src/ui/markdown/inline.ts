import type { Theme } from "../theme.js";
import { BOLD, ITALIC, STRIKE, UNDERLINE, paint } from "./style.js";

// Explicit "off" codes close only their own attribute; a full SGR_RESET here
// would strip colors applied by an enclosing block (e.g. accent headings).
const BOLD_OFF = "\x1b[22m";
const ITALIC_OFF = "\x1b[23m";
const STRIKE_OFF = "\x1b[29m";

type InlineKind = "strong" | "em" | "del" | "codespan";

export function renderInline(kind: InlineKind, inner: string, theme?: Theme): string {
  switch (kind) {
    case "codespan":
      return paint(theme?.accent)(inner);
    case "strong":
      return BOLD + inner + BOLD_OFF;
    case "em":
      return ITALIC + inner + ITALIC_OFF;
    case "del":
      return STRIKE + inner + STRIKE_OFF;
  }
}

function stripCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function isPlainLabel(label: string, href: string): boolean {
  const plain = stripCodes(label);
  return href === plain || href.startsWith("#") || href.startsWith("mailto:");
}

export function renderLink(label: string, href: string, theme?: Theme): string {
  const styled = paint(theme?.accent, UNDERLINE)(label);
  if (isPlainLabel(label, href)) return styled;
  return (
    styled +
    paint(theme?.muted)(" (") +
    paint(theme?.accent)(href) +
    paint(theme?.muted)(")")
  );
}
