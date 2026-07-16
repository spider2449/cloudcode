// Terminal column arithmetic. All layout math in the native TUI must use
// these instead of String.length: CJK characters occupy 2 columns, emoji 2,
// combining marks 0. Under-counting a row's width lets it overflow the
// terminal, which on legacy conhost (DECAWM ignored) wraps, scrolls the
// region and corrupts the pinned footer.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Column width of a single Unicode code point. Unknown ranges default to 1
 * (over-estimating is harmless; under-estimating causes the conhost bug). */
export function charWidth(cp: number): number {
  if (cp === 0x200d) return 0; // zero-width joiner
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritical marks
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control chars
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)   // CJK ext B..
  ) {
    return 2;
  }
  return 1;
}

/** Visible column width of a string; ANSI SGR sequences count as 0. */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncate to at most `max` columns, appending "…" when cut. Strips ANSI. */
export function truncateToWidth(s: string, max: number): string {
  const plain = s.replace(ANSI_RE, "");
  if (stringWidth(plain) <= max) return plain;
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}
