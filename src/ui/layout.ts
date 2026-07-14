import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { sgr, SGR_RESET } from "./term/ansi.js";
import type { Theme } from "./theme.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

const ANSI_TOKEN_RE = /^\x1b\[[0-9;]*m/;

// Wraps at `width` visible (non-ANSI) columns, keeping embedded ANSI codes
// attached to the text they color. Explicit "\n" in the input starts a new
// wrap unit, mirroring bottomFill.ts's per-line row counting.
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (visibleLength(line) === 0) { out.push(""); continue; }
    let currentRow = "";
    let currentVisible = 0;
    let hasContent = false;
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      const escMatch = ANSI_TOKEN_RE.exec(rest);
      if (escMatch) {
        currentRow += escMatch[0];
        i += escMatch[0].length;
        continue;
      }
      currentRow += line[i];
      currentVisible++;
      hasContent = true;
      i++;
      if (currentVisible === w) {
        out.push(currentRow);
        currentRow = "";
        currentVisible = 0;
        hasContent = false;
      }
    }
    if (hasContent) out.push(currentRow);
    else if (currentRow !== "" && out.length > 0) out[out.length - 1] += currentRow;
  }
  return out;
}

function colorize(text: string, colorName: string | undefined): string {
  const code = sgr(colorName);
  return code ? `${code}${text}${SGR_RESET}` : text;
}

export function layoutItem(item: DisplayItem, theme: Theme, width: number): string[] {
  switch (item.kind) {
    case "user":
      return wrapText(colorize("> " + item.text, theme.user), width);
    case "assistant":
      return wrapText(renderMarkdown(item.text), width);
    case "tool":
      return wrapText(colorize("⏺ " + item.label, theme.accent), width);
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
