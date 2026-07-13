export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
// DECAWM: with autowrap on, a row longer than the terminal width wraps; a wrap
// on the bottom row scrolls the whole alt screen and misaligns every frame.
export const AUTOWRAP_OFF = "\x1b[?7l";
export const AUTOWRAP_ON = "\x1b[?7h";
// Basic mouse button tracking (1000) with SGR encoding (1006), so the wheel
// can scroll the transcript on the alt screen. Text selection needs
// Shift+drag while this is active, as in other mouse-capturing TUIs.
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
export const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
export const SGR_RESET = "\x1b[0m";

export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
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
