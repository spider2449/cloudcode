import Table from "cli-table3";
import type { Theme } from "../theme.js";

// cli-table3 only understands @colors/colors style names, not hex, so table
// header/border colors are mapped to the nearest of the 16 standard colors.
const ANSI16_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
];
// The same 16 colors as hex, matching ANSI16_NAMES by index.
const ANSI16_HEX = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"
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

// Widths are sized from the widest cell of each column (not an even split),
// so short columns don't waste pane width that long columns need. When the
// content total exceeds the pane, columns shrink proportionally with a floor
// of 6; flooring can push the total back over budget, so shave the excess off
// the widest columns (never below the floor) until the table fits. Explicit
// widths make cli-table3 wrap cell text itself, so every rendered line
// already fits and wrapText never has to touch it.
export function columnWidths(headerLens: number[], rowLens: number[][], width: number): number[] {
  const maxLens = [...headerLens];
  for (const row of rowLens) {
    row.forEach((len, j) => {
      if (j < maxLens.length) maxLens[j] = Math.max(maxLens[j], len);
    });
  }
  if (maxLens.length === 0) return [];
  const n = maxLens.length;
  // Each column costs its width + 2 padding; borders cost n + 1 columns.
  const desired = maxLens.map((len) => len + 2);
  const budget = width - (n + 1);
  const total = desired.reduce((a, b) => a + b, 0);
  if (total <= budget) return desired;
  const widths = desired.map((w) => Math.max(6, Math.floor((w / total) * budget)));
  let excess = widths.reduce((a, b) => a + b, 0) - budget;
  while (excess > 0) {
    let widest = 0;
    for (let i = 1; i < n; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 6) break;
    widths[widest]--;
    excess--;
  }
  return widths;
}

export function renderTable(
  headerCells: string[],
  rowCells: string[][],
  colWidths: number[],
  theme?: Theme
): string {
  if (headerCells.length === 0 || colWidths.length === 0) return "";
  const table = new Table({
    colWidths,
    wordWrap: true,
    style: {
      head: [nearestColorName(theme?.accent ?? "#ffffff")],
      border: [nearestColorName(theme?.muted ?? "#808080")]
    }
  });
  // Pad short rows so cli-table3 does not render missing trailing cells as
  // empty-but-bordered columns that misalign with the header.
  const width = colWidths.length;
  const padRow = (r: string[]) => {
    const cells = r.slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  };
  table.push(padRow(headerCells), ...rowCells.map(padRow));
  return table.toString();
}
