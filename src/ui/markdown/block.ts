import { wrapText } from "../layout.js";
import { stringWidth } from "../width.js";
import type { Theme } from "../theme.js";
import { BOLD, ITALIC, paint } from "./style.js";
import { highlightCode } from "./highlight.js";

// h1 carries a rule sized to the text (capped at pane width); h2 keeps bold
// weight; h3+ rely on color alone so deep nesting stays visually quiet.
export function renderHeading(text: string, depth: number, width: number, theme?: Theme): string {
  switch (depth) {
    case 1: {
      const rule = paint(theme?.muted)("─".repeat(Math.min(Math.max(1, stringWidth(text)), Math.max(1, width))));
      return paint(theme?.accent, BOLD)(text) + "\n" + rule;
    }
    case 2:
      return paint(theme?.accent, BOLD)(text);
    case 3:
      return paint(theme?.accent)(text);
    default:
      return BOLD + text + "\x1b[22m";
  }
}

export function renderHr(width: number, theme?: Theme): string {
  return paint(theme?.muted)("─".repeat(Math.max(1, width)));
}

// The bar is painted separately from the body so wrapped rows all carry it,
// even where wrapText re-broke ANSI-colored content.
export function renderBlockquote(lines: string[], width: number, theme?: Theme): string {
  const bar = paint(theme?.muted)("▌ ");
  const body = paint(theme?.muted, ITALIC);
  const wrapped = lines.flatMap((l) => wrapText(l, Math.max(4, width - 2)));
  return wrapped.map((l) => bar + body(l)).join("\n");
}

// Content is highlighted first (ANSI-safe), wrapped to the inner width, then
// framed. The box hugs the widest row instead of always spanning full width.
export function renderCodeBlock(code: string, lang: string | undefined, width: number, theme?: Theme): string {
  const frame = paint(theme?.muted);
  const availW = Math.max(8, width - 4);
  const rows = wrapText(highlightCode(code, lang), availW).map((r) => r.trimEnd());
  const w = Math.min(availW, Math.max(1, ...rows.map((r) => stringWidth(r))));
  const pad = (r: string) => r + " ".repeat(Math.max(0, w - stringWidth(r)));
  return [
    frame(`╭${"─".repeat(w + 2)}╮`),
    ...rows.map((r) => frame("│ ") + pad(r) + frame(" │")),
    frame(`╰${"─".repeat(w + 2)}╯`)
  ].join("\n");
}
