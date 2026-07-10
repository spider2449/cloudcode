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

export function loadWelcome(vars: WelcomeVars, filePath = defaultPath()): string | undefined {
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
  return raw
    .replace(/\{(version|provider|model)\}/g, (_, key: string) => values[key])
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}
