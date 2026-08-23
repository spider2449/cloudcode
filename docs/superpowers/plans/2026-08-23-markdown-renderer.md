# Custom Markdown Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the marked-terminal integration in `src/ui/markdown.ts` with a hand-rolled marked renderer for full visual control (syntax highlighting, heading rules, depth-based bullets, blockquote bars, styled hr, framed code boxes, themed tables, tighter spacing).

**Architecture:** Keep `marked` as the parser; override every renderer method on a fresh `Marked` instance per `renderMarkdown()` call (removes the global-state cache hack). Public API `renderMarkdown(text, width = 80, theme?)` is unchanged, so `src/ui/layout.ts` needs no changes. New modules live under `src/ui/markdown/`; `src/ui/markdown.ts` stays as the entry point so existing imports (`./markdown.js`) keep working under NodeNext resolution.

**Tech Stack:** marked ^15 (token-object renderer API, v13+), cli-highlight 2.x (ANSI syntax highlighting), cli-table3 0.6.x (table layout), existing in-house `wrapText`/`stringWidth`/`sgr`.

## Global Constraints

- All code, comments, and identifiers in English only.
- TypeScript strict; no `any`, no non-null `!` assertions (existing code has one `!` total — do not add more).
- No file in `src/` over ~600 lines (`npm run lint:size`).
- Every module gets a test file in `tests/` in the same commit as its feature.
- Width math MUST use `stringWidth`/`charWidth` from `src/ui/width.ts` and wrapping via `wrapText` from `src/ui/layout.ts` (CJK-safe). Never use `String.length` on rendered output.
- Colors only through `sgr()` from `src/ui/term/ansi.js` (respects color depth) plus raw bold/italic/underline/strike SGR constants.
- Existing behavior contracts that tests already pin and must keep passing: table lines fit pane width with complete right borders; no red `\x1b[31m` table headers when a theme is given; h1 contains truecolor accent SGR; nested list indent ≤ 4 columns; long list items wrap with hanging indent; renderer never throws (raw-text fallback).

---

### Task 1: Swap dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove marked-terminal, add cli-highlight + cli-table3**

```bash
npm uninstall marked-terminal @types/marked-terminal
npm install cli-highlight@^2.1.11 cli-table3@^0.6.5
```

- [ ] **Step 2: Verify install**

Run: `npm ls cli-highlight cli-table3 marked`
Expected: all three present, no marked-terminal.

### Task 2: Shared style helpers + syntax highlighting

**Files:**
- Create: `src/ui/markdown/style.ts`
- Create: `src/ui/markdown/highlight.ts`
- Test: `tests/markdown-style.test.ts`

**Interfaces:**
- Produces: `BOLD = "\x1b[1m"`, `ITALIC = "\x1b[3m"`, `STRIKE = "\x1b[9m"`, `UNDERLINE = "\x1b[4m"`, `paint(color: string | undefined, ...extras: string[]): (s: string) => string`, `highlightCode(code: string, lang: string | undefined): string`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { highlightCode } from "../src/ui/markdown/highlight.js";
import { paint } from "../src/ui/markdown/style.js";

describe("highlightCode", () => {
  it("highlights known languages without changing content", () => {
    const out = highlightCode("const x = 1;", "js");
    expect(out).toContain("const x = 1;");
    expect(out).not.toBe("const x = 1;");
    expect(out).toContain("\x1b[");
  });

  it("returns plain text for unknown or missing languages", () => {
    expect(highlightCode("hello", "nope")).toBe("hello");
    expect(highlightCode("hello", undefined)).toBe("hello");
  });

  it("never throws on malformed input", () => {
    expect(() => highlightCode("\ud800 broken", "js")).not.toThrow();
  });
});

describe("paint", () => {
  it("wraps text in color codes and resets", () => {
    expect(paint("#ff0000")("hi")).toBe("\x1b[38;2;255;0;0mhi\x1b[0m");
  });
  it("is identity without color", () => {
    expect(paint(undefined)("hi")).toBe("hi");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/markdown-style.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`style.ts`:

```ts
import { sgr, SGR_RESET } from "../term/ansi.js";

export const BOLD = "\x1b[1m";
export const ITALIC = "\x1b[3m";
export const STRIKE = "\x1b[9m";
export const UNDERLINE = "\x1b[4m";

export function paint(color: string | undefined, ...extras: string[]): (s: string) => string {
  const code = (color ? sgr(color) : "") + extras.join("");
  return code ? (s: string) => `${code}${s}${SGR_RESET}` : (s: string) => s;
}
```

`highlight.ts`:

```ts
import { highlight, supportsLanguage } from "cli-highlight";

// Common fence-info aliases highlight.js does not register under these names.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", zsh: "bash", shell: "bash",
  py: "python", rb: "ruby", yml: "yaml", md: "markdown", rs: "rust", golang: "go"
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
    return highlight(code, { language, ignoreIllegals: true });
  } catch {
    return code;
  }
}
```

Note: if cli-highlight's default output turns out to be HTML rather than ANSI during implementation, stop and re-check its README before proceeding — ANSI output is a hard requirement of this task.

- [ ] **Step 4: Run tests to pass** — `npx vitest run tests/markdown-style.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): add style helpers and ANSI syntax highlighting for markdown"`

### Task 3: Inline renderers

**Files:**
- Create: `src/ui/markdown/inline.ts`
- Test: `tests/markdown-inline.test.ts`

**Interfaces:**
- Consumes: `paint`, `BOLD`, `ITALIC`, `STRIKE`, `UNDERLINE` from `./style.js`.
- Produces: `renderInline(kind: "strong" | "em" | "del" | "codespan", inner: string, theme?: Theme): string` and `renderLink(label: string, href: string, theme?: Theme): string`. Inner text is pre-rendered by the caller (the entry's renderer methods call `this.parser.parseInline(tokens)` first); inline functions are pure string transforms so they are trivially testable without a marked instance.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { renderInline, renderLink } from "../src/ui/markdown/inline.js";

describe("inline renderers", () => {
  it("bolds, italicizes, strikes, and colors codespans", () => {
    expect(renderInline("strong", "x")).toBe("\x1b[1mx\x1b[22m");
    expect(renderInline("em", "x")).toBe("\x1b[3mx\x1b[23m");
    expect(renderInline("del", "x")).toBe("\x1b[9mx\x1b[29m");
    expect(renderInline("codespan", "x", THEME)).toContain("\x1b[38;2;255;0;255m");
  });

  it("shows link href only when it differs from the label", () => {
    expect(renderLink("Example", "https://e.com", THEME)).toContain("(https://e.com)");
    expect(renderLink("https://e.com", "https://e.com", THEME)).not.toContain("(");
    expect(renderLink("Section", "#anchor", THEME)).not.toContain("(");
  });
});

const THEME = {
  user: "#00ff00", accent: "#ff00ff", muted: "#808080", error: "#ff0000",
  success: "#00ff00", removed: "#ff0000", warning: "#ffff00", thinking: "#808080"
};
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
import type { Theme } from "../theme.js";
import { BOLD, ITALIC, STRIKE, UNDERLINE, paint } from "./style.js";

const OFF: Record<string, string> = {
  strong: "\x1b[22m", em: "\x1b[23m", del: "\x1b[29m"
};

type InlineKind = "strong" | "em" | "del" | "codespan";

export function renderInline(kind: InlineKind, inner: string, theme?: Theme): string {
  switch (kind) {
    case "codespan": return paint(theme?.accent)(inner);
    case "strong": return BOLD + inner + OFF.strong;
    case "em": return ITALIC + inner + OFF.em;
    case "del": return STRIKE + inner + OFF.del;
  }
}

function isPlainLabel(label: string, href: string): boolean {
  return href === label || href.startsWith("#") || href.startsWith("mailto:");
}

export function renderLink(label: string, href: string, theme?: Theme): string {
  const styled = paint(theme?.accent, UNDERLINE)(label);
  if (isPlainLabel(stripCodes(label), href)) return styled;
  return `${styled} ${paint(theme?.muted)("(")}${paint(theme?.accent)(href)}${paint(theme?.muted)(")")}`;
}

function stripCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
```

(Images reuse `renderLink` with label `[alt]`.)

- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `feat(ui): markdown inline renderers`

### Task 4: Block renderers

**Files:**
- Create: `src/ui/markdown/block.ts`
- Test: `tests/markdown-block.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers, Task 3 functions, `wrapText` from `../layout.js`, `stringWidth` from `../width.js`.
- Produces pure functions called from the entry's renderer object (which supplies `this.parser.parseInline(...)` results):
  - `renderHeading(text: string, depth: number, width: number, theme?: Theme): string`
  - `renderHr(width: number, theme?: Theme): string`
  - `renderBlockquote(lines: string[], width: number, theme?: Theme): string`
  - `renderCodeBlock(code: string, lang: string | undefined, width: number, theme?: Theme): string`
  - `renderListItem(marker: string, bodyLines: string[], width: number): string`

Visual spec (from approved design):
- h1: accent+bold text, then muted `─` rule spanning min(stringWidth(plainText), width); h2: accent+bold; h3+: accent.
- hr: full-width muted `─`.
- blockquote: each line prefixed `▌ ` in muted, text muted italic, wrapped to width − 2 first.
- code box: content highlighted via `highlightCode`, wrapped to width−4, framed with muted `╭─╮ │ ╰─╯`, box width = widest row capped at width−4.
- list item: first line gets marker, continuations get spaces matching marker length; each body line wrapped to width − marker length.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  renderHeading, renderHr, renderBlockquote, renderCodeBlock, renderListItem
} from "../src/ui/markdown/block.js";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const THEME = { /* same 8-field object as other tests */ };

it("h1 gets an accent rule beneath sized to the text", () => {
  const out = renderHeading("Title", 1, 60, THEME);
  const lines = out.split("\n");
  expect(lines[1]).toMatch(/^─+$/);
  expect(lines[1].length).toBe(5);
});
it("h3 is accent colored without a rule", () => {
  expect(renderHeading("Sub", 3, 60, THEME)).not.toContain("─");
});
it("hr spans the full width", () => {
  expect(strip(renderHr(40, THEME))).toBe("─".repeat(40));
});
it("blockquote prefixes every line with a bar and fits the width", () => {
  const out = renderBlockquote(["word ".repeat(30).trim()], 20, THEME);
  for (const l of strip(out).split("\n")) {
    expect(l.startsWith("▌ ")).toBe(true);
    expect(l.length).toBeLessThanOrEqual(20);
  }
});
it("code box frames highlighted content within the width", () => {
  const out = strip(renderCodeBlock("const x = 1;\nconst yy = 22;", "js", 30, THEME));
  const lines = out.split("\n");
  expect(lines[0].startsWith("╭")).toBe(true);
  expect(lines.at(-1)!.startsWith("╰")).toBe(true);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
  expect(out).toContain("const x = 1;");
});
it("list items hang continuation lines under the marker", () => {
  const body = ["first item with quite a lot of text that must wrap across several lines at this width"];
  const rows = strip(renderListItem("1. ", body, 24)).split("\n");
  expect(rows[0].startsWith("1. ")).toBe(true);
  for (let i = 1; i < rows.length; i++) expect(rows[i].startsWith("   ")).toBe(true);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement block.ts** (~200 lines). Key shapes:

```ts
import { wrapText } from "../layout.js";
import { stringWidth } from "../width.js";
import type { Theme } from "../theme.js";
import { BOLD, ITALIC, paint } from "./style.js";
import { highlightCode } from "./highlight.js";

export function renderHeading(text: string, depth: number, width: number, theme?: Theme): string {
  if (depth === 1) {
    const rule = paint(theme?.muted)("─".repeat(Math.min(Math.max(1, stringWidth(text)), width)));
    return paint(theme?.accent, BOLD)(text) + "\n" + rule;
  }
  if (depth === 2) return paint(theme?.accent, BOLD)(text);
  if (depth >= 4) return BOLD + text + "\x1b[22m";
  return paint(theme?.accent)(text);
}

export function renderHr(width: number, theme?: Theme): string {
  return paint(theme?.muted)("─".repeat(width));
}

export function renderBlockquote(lines: string[], width: number, theme?: Theme): string {
  const bar = paint(theme?.muted)("▌ ");
  const body = paint(theme?.muted, ITALIC);
  const wrapped = lines.flatMap((l) => wrapText(l, Math.max(4, width - 2)));
  return wrapped.map((l) => bar + body(l)).join("\n");
}

export function renderCodeBlock(code: string, lang: string | undefined, width: number, theme?: Theme): string {
  const frame = paint(theme?.muted);
  const availW = Math.max(8, width - 4);
  const rows = wrapText(highlightCode(code, lang), availW).map((r) => r.trimEnd());
  const w = Math.max(1, ...rows.map((r) => Math.min(stringWidth(r), availW)));
  const pad = (r: string) => r + " ".repeat(w - Math.min(stringWidth(r), w));
  return [
    frame(`╭${"─".repeat(w + 2)}╮`),
    ...rows.map((r) => frame("│ ") + pad(r) + frame(" │")),
    frame(`╰${"─".repeat(w + 2)}╯`)
  ].join("\n");
}

export function renderListItem(marker: string, bodyLines: string[], width: number): string {
  const indent = " ".repeat(stringWidth(marker));
  const rows: string[] = [];
  const wrapped = bodyLines.flatMap((l) => wrapText(l, Math.max(4, width - indent.length)));
  wrapped.forEach((r, i) => rows.push((i === 0 ? marker : indent) + r));
  return rows.join("\n");
}
```

- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): markdown block renderers`

### Task 5: Table renderer

**Files:**
- Create: `src/ui/markdown/table.ts`
- Test: extend `tests/markdown.test.ts` table cases (they must keep passing once entry rewires; add direct unit tests here too)

**Interfaces:**
- Consumes: `cli-table3`, `nearestColorName` logic moved here from old markdown.ts.
- Produces:
  - `columnWidths(headerLens: number[], rowLens: number[][], width: number): number[]` (port of existing proportional-shrink-with-floor-6 logic)
  - `renderTable(headerCells: string[], rowCells: string[][], colWidths: number[], theme?: Theme): string` using cli-table3 with `colWidths`, `wordWrap: true`, head/border mapped through `nearestColorName`.

- [ ] **Step 1: Failing tests** — narrow-width table keeps every line ≤ width and ends in a border char; wide-enough table puts `longer value here` on one line; header color equals nearest16(accent) not red.

- [ ] **Step 2–4: Implement + pass.** Port the shrink loop verbatim from current `markdown.ts:29-58`, replacing the regex-based scan with lengths computed by the caller from parsed cells.

- [ ] **Step 5: Commit** — `feat(ui): markdown table renderer with content-based column sizing`

### Task 6: Rewire entry, delete workarounds, full verification

**Files:**
- Modify: `src/ui/markdown.ts` (rewrite, ~110 lines)

- [ ] **Step 1: Rewrite entry**

Structure:

```ts
import { Marked } from "marked";
import type { Tokens } from "marked";
import type { Theme } from "./ui/theme"; // adjust relative import
// ...imports from ./markdown/*.js

export function renderMarkdown(text: string, width = 80, theme?: Theme): string {
  try {
    const w = Math.max(20, width);
    const md = new Marked({ gfm: true });
    let listDepth = 0;
    md.use({
      renderer: {
        heading({ tokens, depth }: Tokens.Heading): string {
          return renderHeading(this.parser.parseInline(tokens), depth, w, theme);
        },
        paragraph({ tokens }: Tokens.Paragraph): string {
          return wrapText(this.parser.parseInline(tokens), w).join("\n");
        },
        hr(): string { return renderHr(w, theme); },
        blockquote({ tokens }: Tokens.Blockquote): string {
          const inner = this.parser.parse(tokens).replace(/\n+$/, "");
          return renderBlockquote(inner.split("\n").filter((l) => l.trim() !== ""), w, theme);
        },
        code({ text, lang }: Tokens.Code): string {
          return renderCodeBlock(text.replace(/\n$/, ""), lang, w, theme);
        },
        list(token: Tokens.List): string {
          listDepth++;
          try {
            return token.items.map((item, i) => {
              const bullet = ["• ", "◦ ", "▪ "][Math.min(listDepth - 1, 2)];
              const marker = token.ordered ? `${(token.start ?? 1) + i}. ` : bullet;
              const body = this.parser.parse(item.tokens).replace(/\n+$/, "").split("\n").filter((l) => l.trim() !== "");
              const check = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
              return renderListItem(check + marker, body, w);
            }).join("\n");
          } finally { listDepth--; }
        },
        table(token: Tokens.Table): string {
          const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens);
          const header = token.header.map(cell);
          const rows = token.rows.map((r) => r.map(cell));
          const widths = columnWidths(header.map(plainLen), rows.map((r) => r.map(plainLen)), w);
          return renderTable(header, rows, widths, theme);
        },
        html({ text }: Tokens.HTML): string { return text.replace(/<[^>]*>/g, ""); },
        space(): string { return ""; },
        // inline overrides delegate to ./markdown/inline.js
      }
    });
    const out = md.parse(text, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
```

Delete: `configuredKey`, `splitCells`, `TABLE_HEADER_RE`, old `tableColumnWidths`, `ANSI16_NAMES`, `nearestColorName`, `BOLD/ITALIC/UNDERLINE`, `paint`, `configure`, `LIST_PREFIX_RE`, `hangingWrap` — all relocated or superseded.

- [ ] **Step 2: Full verification**

```bash
npm run lint && npm run lint:size && npm run build && npx vitest run
```

Expected: zero failures; existing pinned behaviors (table fit/borders/no-red, h1 accent SGR, nested indent ≤ 4, hanging wrap, fallback) all pass.

- [ ] **Step 3: Manual smoke** — `npm run dev`, send a message producing headings/lists/code/table; eyeball output.

- [ ] **Step 4: Commit** — `feat(ui): replace marked-terminal with hand-rolled markdown renderer`
