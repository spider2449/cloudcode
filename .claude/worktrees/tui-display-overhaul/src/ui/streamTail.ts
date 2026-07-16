import { stringWidth } from "./width.js";

// While a response streams in, the text lives in Ink's dynamic region and is
// repainted on every delta. Once that region reaches the terminal height, Ink
// clears and rewrites the whole screen each render, which destroys the user's
// scroll position and makes the TUI jitter until the answer completes. Cap
// the live preview to a tail that always fits; the full text is appended to
// the Static transcript when the turn finishes.
export function tailForHeight(text: string, maxRows: number, columns: number): string {
  const width = Math.max(1, columns);
  const lines = text.split("\n");
  const kept: string[] = [];
  let rows = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    rows += Math.max(1, Math.ceil(stringWidth(line) / width));
    if (rows > maxRows && kept.length > 0) break;
    kept.unshift(line);
    if (rows >= maxRows) break;
  }
  return kept.join("\n");
}
