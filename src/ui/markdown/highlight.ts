import { highlight, supportsLanguage, type Theme } from "cli-highlight";
import { fg } from "./style.js";

// Common fence-info aliases highlight.js does not register under these names.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", zsh: "bash", shell: "bash",
  py: "python", rb: "ruby", yml: "yaml", md: "markdown", rs: "rust", golang: "go"
};

// cli-highlight's default theme routes through chalk, which suppresses color
// when stdout is not a TTY (e.g. tests, pipes). Building the theme from raw
// formatter functions keeps output deterministic everywhere.
const CODE_THEME: Theme = {
  default: (s) => s,
  plain: (s) => s,
  keyword: (s) => `\x1b[1m${fg(35)(s)}`,
  literal: fg(33),
  built_in: fg(33),
  type: fg(36),
  title: fg(36),
  function: fg(36),
  class: fg(36),
  name: fg(94),
  tag: fg(94),
  attribute: fg(94),
  variable: fg(96),
  attr: fg(96),
  number: fg(32),
  string: fg(32),
  symbol: fg(32),
  bullet: fg(32),
  addition: fg(32),
  deletion: fg(31),
  comment: fg(90),
  meta: fg(90),
  doctag: fg(90)
};

function normalizeLang(lang: string | undefined): string | undefined {
  const base = lang?.trim().toLowerCase().split(/\s+/)[0];
  if (!base) return undefined;
  return LANG_ALIASES[base] ?? base;
}

export function highlightCode(code: string, lang: string | undefined): string {
  const language = normalizeLang(lang);
  if (!language || !supportsLanguage(language)) return code;
  try {
    return highlight(code, { language, ignoreIllegals: true, theme: CODE_THEME });
  } catch {
    return code;
  }
}
