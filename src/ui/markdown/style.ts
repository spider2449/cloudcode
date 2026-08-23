import { sgr, SGR_RESET } from "../term/ansi.js";

export const BOLD = "\x1b[1m";
export const ITALIC = "\x1b[3m";
export const STRIKE = "\x1b[9m";
export const UNDERLINE = "\x1b[4m";

// Explicit "off" codes so nested styles close only their own attribute
// instead of resetting everything (SGR_RESET) mid-line.
const BOLD_OFF = "\x1b[22m";
const ITALIC_OFF = "\x1b[23m";
const STRIKE_OFF = "\x1b[29m";

export function paint(color: string | undefined, ...extras: string[]): (s: string) => string {
  const code = (color ? sgr(color) : "") + extras.join("");
  return code ? (s: string) => `${code}${s}${SGR_RESET}` : (s: string) => s;
}

/** Foreground-color formatter for highlight themes: `\x1b[<n>m` set, `39` off. */
export function fg(n: number): (s: string) => string {
  return (s: string) => `\x1b[${n}m${s}\x1b[39m`;
}

export { BOLD_OFF, ITALIC_OFF, STRIKE_OFF };
