export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
// DECAWM: with autowrap on, a row longer than the terminal width wraps; a wrap
// on the bottom row scrolls the whole alt screen and misaligns every frame.
export const AUTOWRAP_OFF = "\x1b[?7l";
export const AUTOWRAP_ON = "\x1b[?7h";
export const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
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

const COLOR_CODES: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, blackBright: 90
};

export function sgr(colorName: string | undefined): string {
  if (!colorName) return "";
  const code = COLOR_CODES[colorName];
  if (code === undefined) return "";
  return `\x1b[${code}m`;
}
