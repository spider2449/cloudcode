import { ANSI16_HEX } from "../themeJson.js";

export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Kitty keyboard protocol, "disambiguate escape codes" flag (bit 1): reports
// key events as CSI u sequences carrying a modifier bitmask, which is what
// lets Shift+Enter be told apart from plain Enter (see input.ts CSI_U_RE).
// Terminals that don't support it (most legacy ones) simply ignore this
// sequence, so it's safe to send unconditionally.
export const KITTY_KEYBOARD_ON = "\x1b[>1u";
export const KITTY_KEYBOARD_OFF = "\x1b[<u";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
// DECAWM: with autowrap on, a row longer than the terminal width wraps; a wrap
// on the bottom row scrolls the whole screen and misaligns every frame.
export const AUTOWRAP_OFF = "\x1b[?7l";
export const AUTOWRAP_ON = "\x1b[?7h";
// OSC 0: set both the window/tab icon name and title. Universally supported
// (xterm, Windows Terminal, ConPTY, iTerm2, ...); terminals that don't
// recognize OSC sequences simply ignore it, so it's safe to send
// unconditionally like the other feature-detection-free sequences above.
export function setTitle(title: string): string {
  return `\x1b]0;${title}\x07`;
}

export const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
// 2J clears only the viewport; 3J also drops the terminal's scrollback so a
// full transcript reprint doesn't stack a duplicate copy above it.
export const CLEAR_ALL_AND_HOME = "\x1b[2J\x1b[3J\x1b[H";
export const SGR_RESET = "\x1b[0m";

// Erase from the cursor to the end of the screen. Used by the inline
// renderer to wipe the previous dynamic block before repainting it.
export const ERASE_DOWN = "\x1b[0J";

export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}

// DECSTBM: confine scrolling to rows top..bottom (1-indexed, inclusive).
// Used to pin the footer band below the scroll region to the terminal's
// bottom edge while the transcript above it scrolls independently.
export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

// Restores the scroll region to the whole screen. Must be written before
// handing control back to the shell, or the shell prompt would be visually
// confined to whatever sub-region the app last used.
export const RESET_SCROLL_REGION = "\x1b[r";

const COLOR_CODES: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, blackBright: 90
};

export type ColorDepth = "truecolor" | "256" | "16";

// Env-only detection; never queries the terminal (legacy conhost mishandles
// several DEC/OSC queries, so probing is off the table).
export function detectColorDepth(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform
): ColorDepth {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  // Windows 10+ conhost and Windows Terminal both render 24-bit SGR.
  if (platform === "win32") return "truecolor";
  if (/256color/.test(env.TERM ?? "")) return "256";
  return "16";
}

let colorDepth: ColorDepth = detectColorDepth();

export function setColorDepth(d: ColorDepth): void {
  colorDepth = d;
}

function hexToRgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Nearest xterm-256 index: pick the better of the closest cube entry and the
// closest grayscale entry by squared RGB distance.
function nearest256([r, g, b]: [number, number, number]): number {
  const level = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : Math.min(5, Math.round((c - 55) / 40)));
  const cubeVal = (i: number) => (i === 0 ? 0 : 55 + i * 40);
  const [ri, gi, bi] = [level(r), level(g), level(b)];
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (cubeVal(ri) - r) ** 2 + (cubeVal(gi) - g) ** 2 + (cubeVal(bi) - b) ** 2;
  const grayIdx = Math.max(0, Math.min(23, Math.round((((r + g + b) / 3) - 8) / 10)));
  const grayVal = 8 + 10 * grayIdx;
  const grayDist = (grayVal - r) ** 2 + (grayVal - g) ** 2 + (grayVal - b) ** 2;
  return grayDist < cubeDist ? 232 + grayIdx : cubeIdx;
}

// Nearest of the standard 16 colors, returned as an SGR foreground code
// (30-37 for 0-7, 90-97 for 8-15).
function nearest16Sgr([r, g, b]: [number, number, number]): number {
  let best = 0;
  let bestDist = Infinity;
  ANSI16_HEX.forEach((hex, i) => {
    const [pr, pg, pb] = hexToRgb(hex)!;
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best < 8 ? 30 + best : 90 + (best - 8);
}

export function sgr(color: string | undefined): string {
  if (!color) return "";
  if (color.startsWith("#")) {
    const rgb = hexToRgb(color);
    if (!rgb) return "";
    if (colorDepth === "truecolor") return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    if (colorDepth === "256") return `\x1b[38;5;${nearest256(rgb)}m`;
    return `\x1b[${nearest16Sgr(rgb)}m`;
  }
  const code = COLOR_CODES[color];
  if (code === undefined) return "";
  return `\x1b[${code}m`;
}
