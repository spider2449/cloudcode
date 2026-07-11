// The transcript renders through <Static> into terminal scrollback, outside
// Ink's layout tree, so its height cannot be measured with measureElement.
// Instead we estimate its rows with the same wrap math as streamTail.ts,
// mirroring how MessageList.renderItem shapes each item. This estimate only
// matters while total content is shorter than the terminal (the filler is 0
// otherwise), so small drift on exotic markdown is acceptable.
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function wrappedRows(line: string, columns: number): number {
  const width = Math.max(1, columns);
  const visible = line.replace(ANSI_RE, "").length;
  return Math.max(1, Math.ceil(visible / width));
}

function textRows(text: string, columns: number): number {
  return text.split("\n").reduce((sum, line) => sum + wrappedRows(line, columns), 0);
}

export function itemRows(item: DisplayItem, columns: number): number {
  switch (item.kind) {
    case "user":
      return textRows("> " + item.text, columns);
    case "assistant":
      return textRows(renderMarkdown(item.text), columns);
    case "tool":
      return textRows("⏺ " + item.label, columns);
    case "notice":
    case "error":
      return textRows(item.text, columns);
    case "diff":
      return item.lines.reduce(
        (sum, l) => sum + wrappedRows(`${l.sign} ${l.text}`, Math.max(1, columns - 2)),
        0
      );
    case "result":
      return 1;
  }
}

export function staticRows(items: DisplayItem[], columns: number, cap: number): number {
  let rows = 0;
  for (const item of items) {
    rows += itemRows(item, columns);
    if (rows >= cap) return cap;
  }
  return rows;
}

export function fillerHeight(terminalRows: number, staticRows: number, dynamicRows: number): number {
  return Math.max(0, terminalRows - staticRows - dynamicRows - 1);
}
