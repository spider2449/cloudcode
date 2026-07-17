import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { sgr, SGR_RESET } from "./term/ansi.js";
import type { Theme } from "./theme.js";
import { charWidth, stringWidth, truncateToWidth } from "./width.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const ANSI_TOKEN_RE = /^\x1b\[[0-9;]*m/;

function visibleWidth(s: string): number {
  // stringWidth() already strips ANSI internally; no need to strip here too.
  return stringWidth(s);
}

// Wraps at `width` visible terminal columns (CJK chars count 2), keeping
// embedded ANSI codes attached to the text they color. Breaks preferentially
// at spaces or after CJK characters (Chinese may break between any two
// characters); a single over-long word is hard-cut. Explicit "\n" starts a
// new wrap unit, mirroring bottomFill.ts's per-line row counting.
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (visibleWidth(line) === 0) {
      // Blank line, or ANSI-only content: keep blanks; re-attach ANSI-only
      // fragments (e.g. a trailing reset) to the previous emitted row.
      if (stripAnsi(line) === "") {
        if (line !== "" && out.length > 0) out[out.length - 1] += line;
        else out.push("");
      } else {
        out.push("");
      }
      continue;
    }
    let row = "";      // current row, including ANSI codes
    let rowW = 0;      // visible columns in `row`
    let breakAt = -1;  // string index into `row` after the last break chance
    let i = 0;
    while (i < line.length) {
      const escMatch = ANSI_TOKEN_RE.exec(line.slice(i));
      if (escMatch) {
        row += escMatch[0];
        i += escMatch[0].length;
        continue;
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const cw = charWidth(cp);
      if (rowW + cw > w) {
        if (ch === " ") {
          // The overflowing char is the break itself: emit the full row and
          // swallow the space instead of backtracking to an earlier break.
          out.push(row.replace(/ +$/, ""));
          row = "";
          rowW = 0;
          breakAt = -1;
          i += 1;
          continue;
        }
        if (breakAt > 0) {
          out.push(row.slice(0, breakAt).replace(/ +$/, ""));
          row = row.slice(breakAt).replace(/^ +/, "");
          rowW = stringWidth(row);
          breakAt = -1;
          continue; // retry the same character on the fresh row
        }
        if (rowW === 0) {
          // The row is already empty and this single character alone
          // exceeds `w` (e.g. a wide CJK/emoji char in a 1-column width).
          // There is no way to make progress by breaking earlier, so hard-cut:
          // emit this one character as its own row (even though it overflows)
          // and advance past it, instead of looping forever on the same char.
          out.push(ch);
          i += ch.length;
          row = "";
          rowW = 0;
          breakAt = -1;
          continue;
        }
        out.push(row);
        row = "";
        rowW = 0;
        breakAt = -1;
        continue; // retry the same character on the fresh row
      }
      row += ch;
      rowW += cw;
      i += ch.length;
      // Break opportunities: after a space, or after any wide (CJK) char.
      if (ch === " " || cw === 2) breakAt = row.length;
    }
    if (rowW > 0) out.push(row);
    else if (row !== "" && out.length > 0) out[out.length - 1] += row;
  }
  return out;
}

function colorize(text: string, colorName: string | undefined): string {
  const code = sgr(colorName);
  return code ? `${code}${text}${SGR_RESET}` : text;
}

// Prefixes a block's first wrapped row with `dot + " "` and indents every
// continuation row by the same width, so wrapped text stays aligned under
// the dot instead of running back to column 0.
function prefixBlock(rows: string[], dot: string): string[] {
  const indent = " ".repeat(dot.length + 1);
  return rows.map((row, i) => (i === 0 ? `${dot} ${row}` : `${indent}${row}`));
}

export function layoutItem(item: DisplayItem, theme: Theme, width: number): string[] {
  switch (item.kind) {
    case "user":
      return wrapText(colorize("> " + item.text, theme.user), width);
    case "assistant": {
      const innerWidth = Math.max(1, width - 2);
      return prefixBlock(wrapText(renderMarkdown(item.text, innerWidth, theme), innerWidth), "●");
    }
    case "tool":
      return wrapText(colorize("● " + item.label, theme.accent), width);
    case "notice":
      return wrapText(colorize(item.text, theme.muted), width);
    case "welcome":
      return [...wrapText(colorize(item.logo, theme.accent), width), ...wrapText(colorize(item.body, theme.muted), width)];
    case "error":
      return wrapText(colorize(item.text, theme.error), width);
    case "diff": {
      const innerWidth = Math.max(1, width - 2);
      const rows: string[] = [];
      for (const l of item.lines) {
        const color = l.sign === "+" ? theme.success : l.sign === "-" ? theme.removed : theme.muted;
        for (const wrapped of wrapText(`${l.sign} ${l.text}`, innerWidth)) {
          rows.push("  " + colorize(wrapped, color));
        }
      }
      return rows;
    }
    case "toolResult": {
      const suffix = item.extra > 0 ? ` (+${item.extra} lines)` : "";
      const line = truncateToWidth(`  ⎿ ${item.text}${suffix}`, Math.max(1, width));
      return [colorize(line, item.isError ? theme.error : theme.muted)];
    }
    case "result": {
      const parts = [
        "✓ done",
        item.costUsd != null ? `$${item.costUsd.toFixed(4)}` : undefined,
        item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined
      ].filter((p): p is string => p !== undefined);
      return [colorize(parts.join(" · "), theme.muted)];
    }
    default: {
      const _exhaustive: never = item;
      return [];
    }
  }
}
