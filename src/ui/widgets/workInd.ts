import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function renderWorkInd(frame: number, label: string, elapsedMs: number, theme: Theme): string {
  const glyph = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
  const seconds = Math.floor(elapsedMs / 1000);
  const accent = sgr(theme.accent);
  const muted = sgr(theme.muted);
  return `${accent}${glyph} ${label}… ${muted}(${seconds}s · Esc to interrupt)${SGR_RESET}`;
}
