import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { wrapText } from "./layout.js";
import { stringWidth } from "./width.js";
import { sgr, SGR_RESET } from "./term/ansi.js";
import { ANSI16_HEX } from "./themeJson.js";
import type { Theme } from "./theme.js";

// Matches a GFM table header line, e.g. "| a | b |" or "a | b".
const TABLE_HEADER_RE = /^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/m;

let configuredKey = "";

function splitCells(line: string): string[] {
  const cells = line.split("|").map((s) => s.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// cli-table3 sizes columns purely from cell content unless `colWidths` is
// given, so a wide table renders wider than the pane and the app's own
// wrapText() then hard-cuts each overflowing row, stripping its border and
// misaligning it from the table. Passing explicit colWidths derived from the
// pane width makes cli-table3 wrap cell text itself, so every rendered line
// already fits and wrapText never has to touch it. Widths are sized from the
// widest cell of each column (not an even split), so short columns don't
// waste pane width that long columns need.
function tableColumnWidths(text: string, width: number): number[] {
  const m = TABLE_HEADER_RE.exec(text);
  if (!m) return [];
  const lines = text.slice(m.index).split("\n");
  const maxLens: number[] = splitCells(lines[0]).map((c) => c.length);
  // Scan the contiguous table body below the header + separator rows.
  for (let i = 2; i < lines.length && lines[i].includes("|"); i++) {
    splitCells(lines[i]).forEach((c, j) => {
      if (j < maxLens.length) maxLens[j] = Math.max(maxLens[j], c.length);
    });
  }
  const n = maxLens.length;
  // Each column costs its width + 2 padding; borders cost n + 1 columns.
  const desired = maxLens.map((len) => len + 2);
  const budget = width - (n + 1);
  const total = desired.reduce((a, b) => a + b, 0);
  if (total <= budget) return desired;
  // Too wide: shrink columns proportionally to their content, floor of 6.
  return desired.map((w) => Math.max(6, Math.floor((w / total) * budget)));
}

// cli-table3 only understands @colors/colors style names, not hex, so table
// header/border colors are mapped to the nearest of the 16 standard colors.
const ANSI16_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
];

function nearestColorName(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "white";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  let best = 7;
  let bestDist = Infinity;
  ANSI16_HEX.forEach((h, i) => {
    const p = parseInt(h.slice(1), 16);
    const d = (((p >> 16) & 0xff) - r) ** 2 + (((p >> 8) & 0xff) - g) ** 2 + ((p & 0xff) - b) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return ANSI16_NAMES[best];
}

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

function paint(color: string | undefined, ...extras: string[]): (s: string) => string {
  const code = (color ? sgr(color) : "") + extras.join("");
  return code ? (s: string) => `${code}${s}${SGR_RESET}` : (s: string) => s;
}

function configure(width: number, colWidths: number[], theme: Theme | undefined): void {
  const key = `${width}|${colWidths.join(",")}|${theme?.accent ?? ""}|${theme?.muted ?? ""}`;
  if (configuredKey === key) return;
  configuredKey = key;
  const tableOptions: Record<string, unknown> = colWidths.length > 0 ? { wordWrap: true, colWidths } : {};
  const themed = theme
    ? {
        heading: paint(theme.accent, BOLD),
        firstHeading: paint(theme.accent, BOLD, UNDERLINE),
        blockquote: paint(theme.muted, ITALIC),
        codespan: paint(theme.accent),
        link: paint(theme.accent),
        href: paint(theme.accent, UNDERLINE),
        tableOptions: {
          ...tableOptions,
          style: { head: [nearestColorName(theme.accent)], border: [nearestColorName(theme.muted)] }
        }
      }
    : { tableOptions };
  marked.use(markedTerminal({ width, reflowText: true, tab: 2, ...themed }) as Parameters<typeof marked.use>[0]);
}

// Leading list marker of a rendered line: indentation plus an optional
// bullet ("* ", "- ", "• ") or number ("12. ").
const LIST_PREFIX_RE = /^(\s*)((?:[*\-•]|\d+\.)\s+)?/;

// marked-terminal's reflowText only reflows paragraphs and headings; list
// items pass through at their full source length. Without this pass those
// over-width lines reach the app's generic wrapText, which knows nothing
// about list structure and wraps their tails back to column 0, stranding
// orphan words under the bullets. Wrap them here instead, indenting each
// continuation row to align under the item's own text.
function hangingWrap(rendered: string, width: number): string {
  const out: string[] = [];
  for (const line of rendered.split("\n")) {
    if (stringWidth(line) <= width) {
      out.push(line);
      continue;
    }
    // Matching against the raw line is safe: the prefix pattern is plain
    // text, so a match can never end inside an ANSI escape.
    const m = LIST_PREFIX_RE.exec(line)!;
    const prefix = m[0];
    const indent = " ".repeat(prefix.length);
    const rows = wrapText(line.slice(prefix.length), Math.max(1, width - prefix.length));
    rows.forEach((row, i) => out.push((i === 0 ? prefix : indent) + row));
  }
  return out.join("\n");
}

export function renderMarkdown(text: string, width = 80, theme?: Theme): string {
  try {
    configure(width, tableColumnWidths(text, width), theme);
    const out = marked.parse(text, { async: false }) as string;
    return hangingWrap(out.replace(/\n+$/, ""), width);
  } catch {
    return text;
  }
}
