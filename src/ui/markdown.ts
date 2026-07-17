import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Matches a GFM table header line, e.g. "| a | b |" or "a | b".
const TABLE_HEADER_RE = /^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/m;

let configuredWidth = -1;
let configuredColumns = -1;

// cli-table3 sizes columns purely from cell content unless `colWidths` is
// given, so a wide table renders wider than the pane and the app's own
// wrapText() then hard-cuts each overflowing row, stripping its border and
// misaligning it from the table. Passing explicit colWidths derived from the
// pane width makes cli-table3 wrap cell text itself, so every rendered line
// already fits and wrapText never has to touch it.
function columnsInText(text: string): number {
  const m = TABLE_HEADER_RE.exec(text);
  if (!m) return 0;
  const header = m[0].split("\n")[0];
  const cells = header.split("|").map((s) => s.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells.length;
}

function configure(width: number, columns: number): void {
  if (configuredWidth === width && configuredColumns === columns) return;
  configuredWidth = width;
  configuredColumns = columns;
  const tableOptions =
    columns > 0
      ? { wordWrap: true, colWidths: Array(columns).fill(Math.max(6, Math.floor((width - columns - 1) / columns) - 2)) }
      : {};
  marked.use(markedTerminal({ width, reflowText: true, tableOptions }) as Parameters<typeof marked.use>[0]);
}

export function renderMarkdown(text: string, width = 80): string {
  try {
    configure(width, columnsInText(text));
    const out = marked.parse(text, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
