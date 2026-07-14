import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WelcomeVars {
  version: string;
  provider: string;
  model?: string;
}

let embeddedWelcome: string | undefined;

/** Used by single-file binary builds, where welcome.txt is embedded rather than on disk. */
export function setEmbeddedWelcome(text: string): void {
  embeddedWelcome = text;
}

function defaultPath(): string {
  // src/ui/ (dev) and dist/ui/ (build) are both two levels below package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "welcome.txt");
}

/** Terminal area the banner must fit inside (rows already excludes the footer). */
export interface WelcomeFit {
  rows: number;
  columns: number;
}

function wrappedRowCount(text: string, columns: number): number {
  const w = Math.max(1, columns);
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / w)), 0);
}

export function loadWelcome(vars: WelcomeVars, filePath = defaultPath(), fit?: WelcomeFit): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    if (embeddedWelcome === undefined) return undefined;
    raw = embeddedWelcome;
  }
  const values: Record<string, string> = {
    version: vars.version,
    provider: vars.provider,
    model: vars.model ?? ""
  };
  let text = raw
    .replace(/\{(version|provider|model)\}/g, (_, key: string) => values[key])
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
  // When the banner would overflow the terminal (short window, or a narrow one
  // that wraps the wide ASCII-art rows), drop the leading logo block — the
  // lines up to the first blank line — and keep the informative text.
  if (fit && wrappedRowCount(text, fit.columns) > fit.rows) {
    const blank = text.indexOf("\n\n");
    if (blank !== -1) text = text.slice(blank + 2).replace(/^\n+/, "");
  }
  return text;
}

/** Splits welcome text into the leading logo block (if any) and the rest, for separate coloring. */
export function splitWelcomeLogo(text: string): { logo?: string; body: string } {
  const blank = text.indexOf("\n\n");
  if (blank === -1) return { body: text };
  return { logo: text.slice(0, blank), body: text.slice(blank + 2) };
}
