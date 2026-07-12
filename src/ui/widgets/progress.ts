import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export function renderProgress(label: string, pct: number, theme: Theme, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const accent = sgr(theme.accent);
  const muted = sgr(theme.muted);
  return `${accent}${label} ${muted}[${bar}] ${clamped}%${SGR_RESET}`;
}
