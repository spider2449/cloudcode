import type { Suggestion } from "../../commands/completion.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export const MAX_ROWS = 8;

export function visibleWindow(count: number, selected: number, max = MAX_ROWS): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - max + 1), count - max);
  return { start, end: start + max };
}

export function renderMenu(suggestions: Suggestion[], selected: number, theme: Theme, width: number): string[] {
  if (suggestions.length === 0) return [];
  const { start, end } = visibleWindow(suggestions.length, selected);
  const labelWidth = Math.max(...suggestions.map(s => s.label.length));
  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const s = suggestions[i];
    const isSelected = i === selected;
    const prefix = isSelected ? "▶ " : "  ";
    const label = s.label.padEnd(labelWidth + 2);
    const accent = isSelected ? sgr(theme.accent) : "";
    const muted = sgr(theme.muted);
    const left = accent ? `${accent}${prefix}${label}${SGR_RESET}` : `${prefix}${label}`;
    const desc = s.description ? ` ${muted}${s.description}${SGR_RESET}` : "";
    void width;
    rows.push(left + desc);
  }
  return rows;
}
