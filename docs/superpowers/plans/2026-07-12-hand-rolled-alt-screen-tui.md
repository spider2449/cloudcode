# Hand-Rolled Alt-Screen TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Ink + `<Static>` UI layer in `src/ui/` with a hand-rolled renderer that runs in the terminal's alternate screen buffer, so the StatusBar is permanently pinned to the bottom row and history is read via an in-app scrollback buffer, behind an opt-in `--tui native` flag.

**Architecture:** Four layers under `src/ui/`: `term/` (ansi escape strings, raw-TTY ownership, frame composition), `buffer.ts` (append-only DisplayItem scrollback with cumulative-row index), `layout.ts` + `widgets/` (pure/stateful row-string producers), and `App.ts` (an Ink-free orchestrator that owns all widget instances, routes decoded keys and `EngineMessage`s, and calls `render()` once per event). `src/agent/`, `src/engine/`, `src/commands/`, `src/version.ts`, `transcript.ts`, `markdown.ts`, `theme.ts`, `streamTail.ts` are untouched or moved verbatim.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, no UI framework (Ink/React removed). Raw ANSI escape sequences for rendering.

## Global Constraints

- Alt screen: enter with `\x1b[?1049h` at startup, leave with `\x1b[?1049l` at exit (spec Decisions ¶2).
- Each frame is a full repaint: `\x1b[H` + `\x1b[2J` then a positional write of every visible row (spec Decisions ¶2). No diff-based incremental repaint (spec Out of Scope).
- Bracketed paste: `\x1b[?2004h` at startup, `\x1b[?2004l` at exit (spec Decisions ¶3).
- StatusBar is always the last row written, at `stdout.rows`, painted structurally last every frame (spec Architecture, Frame Composition).
- No mouse support inside the TUI; in-app scrollback navigation only (`PgUp`/`PgDn`/`Home`/`End`/`Ctrl-B`/`Ctrl-F`) (spec Decisions ¶3, Out of Scope).
- `src/agent/`, `src/engine/`, `src/commands/`, `src/version.ts`, and the 44 non-UI test files are untouched (spec Decisions ¶6, Out of Scope).
- `transcript.ts`, `markdown.ts`, `theme.ts`, `streamTail.ts` are kept verbatim — no changes, no relocation (spec Architecture).
- Rollout is incremental: new files land as inert siblings first (steps 1–2), then an opt-in `--tui native` CLI flag wires them in (step 3) while the Ink UI stays default. Flipping the default and deleting the Ink UI (spec Rollout steps 4–5) requires real-terminal dogfooding across Windows Terminal/conhost/iTerm2/SSH and is explicitly **out of scope for this plan** — this plan implements steps 1–3 only, ending with both UIs buildable, both test-green, and the new UI reachable via `--tui native`.
- Test runner: vitest (`npm test` → `vitest run`). New UI tests are `*.test.ts` (no JSX); no `ink-testing-library`.
- `tsconfig.json` keeps `"jsx": "react-jsx"` and `package.json`'s Ink/React deps until the final cleanup task (Task 19), since Tasks 1–18 must keep the existing Ink UI building and its tests green throughout (incremental rollout constraint above).

---

## File Structure

```
src/ui/
├── term/
│   ├── ansi.ts         [Task 1]  Escape-sequence constants + pure helpers.
│   ├── render.ts        [Task 15] Pure frame composer: (Buffer, scrollOffset, BottomState, theme, size) => string.
│   └── terminal.ts      [Task 16] Owns stdin/stdout; FakeTerminal for tests.
├── buffer.ts             [Task 4]  Scrollback store + cumulative-rows index.
├── layout.ts             [Task 2]  wrapText, stripAnsi, layoutItem.
├── widgets/
│   ├── statusBar.ts      [Task 5]
│   ├── workInd.ts        [Task 6]
│   ├── progress.ts       [Task 7]
│   ├── menu.ts           [Task 8]
│   ├── inputBox.ts        [Task 11] Stateful class, port of InputBox.tsx.
│   └── overlay.ts        [Tasks 12-14] OverlayManager: resume/project/permission.
├── input.ts               [Task 9]  KeyDecoder: feed(chunk) => Key[].
├── nativeApp.ts           [Tasks 16-17] Orchestrator (temporary name; renamed to
│                           App.ts once legacy src/ui/App.tsx is deleted — see
│                           Follow-up work).
├── transcript.ts          (unchanged)
├── markdown.ts            (unchanged)
├── theme.ts                (unchanged)
├── streamTail.ts          (unchanged)
└── useGitStatus.ts        [Task 18] Port: plain function, React wrapper removed.
src/cli.ts                  [Task 19] Replaces src/cli.tsx; --tui native flag.
```

## Interface Summary (cross-task contract)

These exact names/signatures are relied on by later tasks; keep them stable.

```ts
// src/ui/term/ansi.ts
export const ALT_SCREEN_ON: string;   // "\x1b[?1049h"
export const ALT_SCREEN_OFF: string;  // "\x1b[?1049l"
export const BRACKETED_PASTE_ON: string;  // "\x1b[?2004h"
export const BRACKETED_PASTE_OFF: string; // "\x1b[?2004l"
export const CURSOR_HIDE: string;     // "\x1b[?25l"
export const CURSOR_SHOW: string;     // "\x1b[?25h"
export const CLEAR_AND_HOME: string;  // "\x1b[2J\x1b[H"
export function cursorTo(row: number, col: number): string; // "\x1b[<row>;<col>H", 1-indexed
export function sgr(colorName: string | undefined): string; // ANSI color-name -> SGR escape, "" for undefined
export const SGR_RESET: string;       // "\x1b[0m"

// src/ui/layout.ts
export function stripAnsi(text: string): string;
export function wrapText(text: string, width: number): string[];
export function layoutItem(item: DisplayItem, theme: Theme, width: number): string[];

// src/ui/buffer.ts
export class Buffer {
  append(item: DisplayItem): void;
  visibleWindow(startRow: number | null, height: number, width: number, theme: Theme): { rows: string[]; tailRow: number };
  totalRows(width: number, theme: Theme): number;
  clear(): void;
}

// src/ui/widgets/statusBar.ts
export interface StatusBarProps {
  provider: string; model?: string; servedModel?: string; mode: string; cwd: string;
  costUsd?: number; gitBranch?: string; gitDirty?: boolean; tokens?: number;
  contextPct?: number; elapsedMs?: number; scrollHint?: boolean;
}
export function renderStatusBar(p: StatusBarProps, theme: Theme, width: number): string;
export function formatTokens(n: number): string;
export function formatElapsed(ms: number): string;

// src/ui/widgets/workInd.ts
export function renderWorkInd(frame: number, label: string, elapsedMs: number, theme: Theme): string;

// src/ui/widgets/progress.ts
export function renderProgress(label: string, pct: number, theme: Theme, width?: number): string;

// src/ui/widgets/menu.ts
export function renderMenu(suggestions: Suggestion[], selected: number, theme: Theme, width: number): string[];

// src/ui/input.ts
export type Key =
  | { t: "printable"; ch: string } | { t: "paste"; text: string }
  | { t: "enter" } | { t: "tab" } | { t: "backtab" }
  | { t: "backspace" } | { t: "delete" } | { t: "esc" }
  | { t: "up" } | { t: "down" } | { t: "left" } | { t: "right" }
  | { t: "home" } | { t: "end" } | { t: "pgup" } | { t: "pgdn" }
  | { t: "ctrl"; ch: string } | { t: "alt"; ch: string };
export class KeyDecoder { feed(chunk: Buffer): Key[]; }

// src/ui/widgets/inputBox.ts
export interface InputBoxRender {
  borderRows: string[]; contentRows: string[]; menuRows: string[];
  hintRow: string | null; totalRows: number;
}
export class InputBox {
  constructor(completionCtx: CompletionContext, history: History);
  handleKey(k: Key, disabled: boolean): void;
  handlePaste(text: string, disabled: boolean): { submitText?: string } | void;
  render(theme: Theme, width: number, disabled: boolean): InputBoxRender;
  onSubmit: ((text: string) => void) | undefined;
}

// src/ui/widgets/overlay.ts
export type OverlayMode = "none" | "resume" | "project" | "permission";
export class OverlayManager {
  get mode(): OverlayMode;
  get isOpen(): boolean;
  openResume(entries: SessionEntry[], onPick: (e: SessionEntry) => void, onCancel: () => void): void;
  openProject(projects: string[], currentCwd: string, onPick: (p: string) => void, onCancel: () => void): void;
  openPermission(request: PermissionRequest, onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void): void;
  close(): void;
  handleKey(k: Key, input?: string): void;
  render(theme: Theme, width: number): string[];
}

// src/ui/term/render.ts
export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean; streamingText: string; activeTool?: string;
  compactPct?: number; scrollOffset: number | null;
  inputRender: InputBoxRender; overlayRows: string[];
  statusBarProps: StatusBarProps; workIndFrame: number; workStartedAt: number;
}
export function render(buffer: Buffer, scrollOffset: number | null, bottom: BottomState, theme: Theme, size: { rows: number; columns: number }): string;

// src/ui/term/terminal.ts
export interface ITerminal {
  isTTY: boolean;
  size(): { rows: number; columns: number };
  write(s: string): void;
  onData(cb: (chunk: Buffer) => void): void;
  onResize(cb: () => void): void;
  onLine(cb: (line: string) => void): void; // non-TTY fallback
  cleanup(): void;
}
export class Terminal implements ITerminal { /* real stdin/stdout */ }
export class FakeTerminal implements ITerminal { writes: string[]; /* test double */ }

// src/ui/nativeApp.ts (temporary filename during Ink/hand-rolled coexistence;
// see Task 16's note and Follow-up work)
export interface AppProps { /* identical fields to today's AppProps in App.tsx */ }
export class App {
  constructor(props: AppProps, terminal: ITerminal);
  run(): Promise<void>;
  handleMessage(msg: EngineMessage): void;
  handleKey(k: Key): void;
  handleKeys(ks: Key[]): void;
  tick(): void;
  recompute(): void;
}
```

---

### Task 1: `term/ansi.ts` — escape sequence constants

**Files:**
- Create: `src/ui/term/ansi.ts`
- Test: `tests/ansi.test.ts`

**Interfaces:**
- Produces: `ALT_SCREEN_ON`, `ALT_SCREEN_OFF`, `BRACKETED_PASTE_ON`, `BRACKETED_PASTE_OFF`, `CURSOR_HIDE`, `CURSOR_SHOW`, `CLEAR_AND_HOME`, `cursorTo(row, col)`, `sgr(colorName)`, `SGR_RESET` — used by Task 15 (`render.ts`) and Task 16 (`terminal.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ansi.test.ts
import { describe, it, expect } from "vitest";
import { ALT_SCREEN_ON, ALT_SCREEN_OFF, BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF,
  CURSOR_HIDE, CURSOR_SHOW, CLEAR_AND_HOME, cursorTo, sgr, SGR_RESET } from "../src/ui/term/ansi.js";

describe("ansi", () => {
  it("exposes the exact escape sequences the spec requires", () => {
    expect(ALT_SCREEN_ON).toBe("\x1b[?1049h");
    expect(ALT_SCREEN_OFF).toBe("\x1b[?1049l");
    expect(BRACKETED_PASTE_ON).toBe("\x1b[?2004h");
    expect(BRACKETED_PASTE_OFF).toBe("\x1b[?2004l");
    expect(CURSOR_HIDE).toBe("\x1b[?25l");
    expect(CURSOR_SHOW).toBe("\x1b[?25h");
    expect(CLEAR_AND_HOME).toBe("\x1b[2J\x1b[H");
    expect(SGR_RESET).toBe("\x1b[0m");
  });

  it("cursorTo builds a 1-indexed row;col escape", () => {
    expect(cursorTo(1, 1)).toBe("\x1b[1;1H");
    expect(cursorTo(24, 80)).toBe("\x1b[24;80H");
  });

  it("sgr maps known color names to SGR codes and passes through gracefully", () => {
    expect(sgr("red")).toBe("\x1b[31m");
    expect(sgr("green")).toBe("\x1b[32m");
    expect(sgr("yellow")).toBe("\x1b[33m");
    expect(sgr("blue")).toBe("\x1b[34m");
    expect(sgr("magenta")).toBe("\x1b[35m");
    expect(sgr("cyan")).toBe("\x1b[36m");
    expect(sgr("white")).toBe("\x1b[37m");
    expect(sgr("gray")).toBe("\x1b[90m");
    expect(sgr("blackBright")).toBe("\x1b[90m");
    expect(sgr(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ansi.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/term/ansi.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/term/ansi.ts
export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ansi.test.ts`
Expected: PASS (10 assertions across 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/ansi.ts tests/ansi.test.ts
git commit -m "feat(ui): add ansi escape-sequence helpers for hand-rolled TUI"
```

---

### Task 2: `layout.ts` — wrapping and per-kind DisplayItem formatting

**Files:**
- Create: `src/ui/layout.ts`
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: `DisplayItem`, `DiffLine` from `../src/ui/transcript.ts` (unchanged); `renderMarkdown` from `../src/ui/markdown.ts` (unchanged); `Theme` from `../src/ui/theme.ts` (unchanged); `sgr`, `SGR_RESET` from `./term/ansi.js` (Task 1).
- Produces: `stripAnsi(text)`, `wrapText(text, width)`, `layoutItem(item, theme, width)` — used by Task 4 (`buffer.ts`) and Task 15 (`render.ts`).

Ports `bottomFill.ts`'s `ANSI_RE`/wrap math (kept as row-*count* math there) into a version that returns actual row *strings*, and reproduces `MessageList.tsx`'s `renderItem` per-kind formatting (colors via `sgr` instead of Ink's `<Text color>`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/layout.test.ts
import { describe, it, expect } from "vitest";
import { stripAnsi, wrapText, layoutItem } from "../src/ui/layout.js";
import { THEMES } from "../src/ui/theme.js";
import type { DisplayItem } from "../src/ui/transcript.js";

const theme = THEMES.dark;

describe("stripAnsi", () => {
  it("removes SGR escapes and leaves plain text", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });
});

describe("wrapText", () => {
  it("returns the text unwrapped when it fits", () => {
    expect(wrapText("hello", 10)).toEqual(["hello"]);
  });

  it("wraps a single long line at width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("preserves explicit newlines as separate wrap units", () => {
    expect(wrapText("ab\ncdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  it("returns one empty row for an empty string", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("ignores ANSI escapes when measuring width", () => {
    const styled = "\x1b[31mabcd\x1b[0mefgh";
    // visible length is 8 ("abcdefgh"); at width 4 it must split into two rows
    expect(wrapText(styled, 4).length).toBe(2);
  });
});

describe("layoutItem", () => {
  it("formats a user item with '> ' prefix in theme.user color", () => {
    const item: DisplayItem = { kind: "user", text: "hi" };
    const rows = layoutItem(item, theme, 80);
    expect(rows.join("\n")).toContain("> hi");
  });

  it("formats a tool item with the accent-colored bullet prefix", () => {
    const item: DisplayItem = { kind: "tool", label: "Read foo.ts" };
    const rows = layoutItem(item, theme, 80);
    expect(rows.join("\n")).toContain("⏺ Read foo.ts");
  });

  it("formats a result item as one summary row", () => {
    const item: DisplayItem = { kind: "result", costUsd: 0.01, durationMs: 2500 };
    const rows = layoutItem(item, theme, 80);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("✓ done");
    expect(rows[0]).toContain("$0.0100");
    expect(rows[0]).toContain("2.5s");
  });

  it("formats a diff item with left-padded sign-prefixed lines wrapped inside width-2", () => {
    const item: DisplayItem = {
      kind: "diff",
      lines: [{ sign: "+", text: "added" }, { sign: "-", text: "removed" }]
    };
    const rows = layoutItem(item, theme, 20);
    expect(rows.some(r => r.includes("+ added"))).toBe(true);
    expect(rows.some(r => r.includes("- removed"))).toBe(true);
  });

  it("wraps a long assistant markdown line at the given width", () => {
    const item: DisplayItem = { kind: "assistant", text: "word ".repeat(30).trim() };
    const rows = layoutItem(item, theme, 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(stripAnsi(r).length).toBeLessThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/layout.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/layout.ts
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { sgr, SGR_RESET } from "./term/ansi.js";
import type { Theme } from "./theme.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

// Wraps at `width` visible (non-ANSI) columns. Explicit "\n" in the input
// starts a new wrap unit, mirroring bottomFill.ts's per-line row counting.
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (visibleLength(line) === 0) { out.push(""); continue; }
    let rest = line;
    while (visibleLength(rest) > w) {
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    out.push(rest);
  }
  return out;
}

function colorize(text: string, colorName: string | undefined): string {
  const code = sgr(colorName);
  return code ? `${code}${text}${SGR_RESET}` : text;
}

export function layoutItem(item: DisplayItem, theme: Theme, width: number): string[] {
  switch (item.kind) {
    case "user":
      return wrapText(colorize("> " + item.text, theme.user), width);
    case "assistant":
      return wrapText(renderMarkdown(item.text), width);
    case "tool":
      return wrapText(colorize("⏺ " + item.label, theme.accent), width);
    case "notice":
      return wrapText(colorize(item.text, theme.muted), width);
    case "error":
      return wrapText(colorize(item.text, theme.error), width);
    case "diff": {
      const innerWidth = Math.max(1, width - 2);
      const rows: string[] = [];
      for (const l of item.lines) {
        const color = l.sign === "+" ? theme.success : l.sign === "-" ? theme.removed : theme.muted;
        for (const wrapped of wrapText(`${l.sign} ${l.text}`, innerWidth)) {
          rows.push("  " + colorize(wrapped, color));
        }
      }
      return rows;
    }
    case "result": {
      const parts = [
        "✓ done",
        item.costUsd != null ? `$${item.costUsd.toFixed(4)}` : undefined,
        item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined
      ].filter((p): p is string => p !== undefined);
      return [colorize(parts.join(" · "), theme.muted)];
    }
    default: {
      const _exhaustive: never = item;
      return [];
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/layout.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout.ts tests/layout.test.ts
git commit -m "feat(ui): add pure wrapping and DisplayItem layout for hand-rolled TUI"
```

---

### Task 3: `buffer.ts` — append-only scrollback with cumulative-rows index

**Files:**
- Create: `src/ui/buffer.ts`
- Test: `tests/buffer.test.ts`

**Interfaces:**
- Consumes: `DisplayItem` from `./transcript.js`; `layoutItem` from `./layout.js` (Task 2); `Theme` from `./theme.js`.
- Produces: `class Buffer` with `append`, `visibleWindow`, `totalRows`, `clear` — used by Task 15 (`render.ts`) and Task 16 (`nativeApp.ts`).

```ts
export class Buffer {
  append(item: DisplayItem): void;
  visibleWindow(startRow: number | null, height: number, width: number, theme: Theme):
    { rows: string[]; tailRow: number };
  totalRows(width: number, theme: Theme): number;
  clear(): void;
}
```

- `startRow === null` means stick-to-bottom: return the last `height` rows (or fewer if there aren't that many), and `tailRow` is the 0-indexed row number of the last row returned (or `-1` if the buffer is empty).
- `startRow` a number means an absolute 0-indexed row offset from the top: return rows `[startRow, startRow + height)`, clamped to the total row count.
- The cumulative-rows index (`rowOffsets: number[]`, `rowOffsets[i]` = total rows items `0..i-1` occupy) is rebuilt lazily whenever `width` changes from the last call, then reused across calls at that width.

- [ ] **Step 1: Write the failing test**

```ts
// tests/buffer.test.ts
import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";
import type { DisplayItem } from "../src/ui/transcript.js";

const theme = THEMES.dark;

function notice(text: string): DisplayItem {
  return { kind: "notice", text };
}

describe("Buffer", () => {
  it("starts empty", () => {
    const buf = new Buffer();
    expect(buf.totalRows(80, theme)).toBe(0);
    expect(buf.visibleWindow(null, 5, 80, theme)).toEqual({ rows: [], tailRow: -1 });
  });

  it("append grows totalRows by the item's wrapped row count", () => {
    const buf = new Buffer();
    buf.append(notice("one line"));
    expect(buf.totalRows(80, theme)).toBe(1);
    buf.append(notice("a\nb\nc"));
    expect(buf.totalRows(80, theme)).toBe(4);
  });

  it("stick-to-bottom (startRow=null) returns the tail window", () => {
    const buf = new Buffer();
    for (let i = 0; i < 10; i++) buf.append(notice(`line${i}`));
    const { rows, tailRow } = buf.visibleWindow(null, 3, 80, theme);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("line9");
    expect(tailRow).toBe(9);
  });

  it("an absolute startRow returns rows starting at that offset", () => {
    const buf = new Buffer();
    for (let i = 0; i < 10; i++) buf.append(notice(`line${i}`));
    const { rows } = buf.visibleWindow(0, 3, 80, theme);
    expect(rows[0]).toContain("line0");
    expect(rows[2]).toContain("line2");
  });

  it("re-wraps correctly across a width change (resize)", () => {
    const buf = new Buffer();
    buf.append(notice("abcdefgh"));
    expect(buf.totalRows(4, theme)).toBe(2);
    expect(buf.totalRows(8, theme)).toBe(1);
  });

  it("clear empties the buffer", () => {
    const buf = new Buffer();
    buf.append(notice("x"));
    buf.clear();
    expect(buf.totalRows(80, theme)).toBe(0);
    expect(buf.visibleWindow(null, 5, 80, theme).tailRow).toBe(-1);
  });

  it("visibleWindow at the end of a short buffer returns fewer rows than height without padding", () => {
    const buf = new Buffer();
    buf.append(notice("only one line"));
    const { rows } = buf.visibleWindow(null, 5, 80, theme);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buffer.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/buffer.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/buffer.ts
import type { DisplayItem } from "./transcript.js";
import { layoutItem } from "./layout.js";
import type { Theme } from "./theme.js";

export class Buffer {
  private items: DisplayItem[] = [];
  private rowOffsets: number[] = [0];
  private cachedWidth = -1;

  append(item: DisplayItem): void {
    this.items.push(item);
    // Invalidate the index; it is rebuilt lazily on next read at whatever
    // width is requested (append itself never lays anything out).
    this.rowOffsets = [0];
    this.cachedWidth = -1;
  }

  clear(): void {
    this.items = [];
    this.rowOffsets = [0];
    this.cachedWidth = -1;
  }

  private ensureIndex(width: number, theme: Theme): void {
    if (this.cachedWidth === width && this.rowOffsets.length === this.items.length + 1) return;
    const offsets = [0];
    for (const item of this.items) {
      offsets.push(offsets[offsets.length - 1] + layoutItem(item, theme, width).length);
    }
    this.rowOffsets = offsets;
    this.cachedWidth = width;
  }

  totalRows(width: number, theme: Theme): number {
    this.ensureIndex(width, theme);
    return this.rowOffsets[this.rowOffsets.length - 1];
  }

  visibleWindow(
    startRow: number | null,
    height: number,
    width: number,
    theme: Theme
  ): { rows: string[]; tailRow: number } {
    this.ensureIndex(width, theme);
    const total = this.rowOffsets[this.rowOffsets.length - 1];
    if (total === 0) return { rows: [], tailRow: -1 };

    const from = startRow === null ? Math.max(0, total - height) : Math.max(0, Math.min(startRow, total));
    const to = Math.min(total, from + height);

    // Binary search for the first item whose range contains row `from`.
    let lo = 0, hi = this.rowOffsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowOffsets[mid + 1] <= from) lo = mid + 1; else hi = mid;
    }

    const rows: string[] = [];
    let itemIndex = lo;
    let cursor = this.rowOffsets[lo];
    while (cursor < to && itemIndex < this.items.length) {
      const itemRows = layoutItem(this.items[itemIndex], theme, width);
      for (let r = 0; r < itemRows.length && cursor < to; r++, cursor++) {
        if (cursor >= from) rows.push(itemRows[r]);
      }
      itemIndex++;
    }
    return { rows, tailRow: to - 1 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/buffer.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/buffer.ts tests/buffer.test.ts
git commit -m "feat(ui): add append-only scrollback Buffer with cumulative-rows index"
```

---

### Task 4: `widgets/statusBar.ts` — pure StatusBar row

**Files:**
- Create: `src/ui/widgets/statusBar.ts`
- Test: `tests/widgets.test.ts` (this task creates the file; later widget tasks append to it)

**Interfaces:**
- Consumes: `Theme` from `../theme.js`; `sgr`, `SGR_RESET` from `../term/ansi.js`.
- Produces: `StatusBarProps`, `renderStatusBar(p, theme, width)`, `formatTokens(n)`, `formatElapsed(ms)` — used by Task 15 (`render.ts`) and Task 16 (`nativeApp.ts`).

Direct port of `StatusBar.tsx`. `formatTokens`/`formatElapsed` are copied verbatim (`StatusBar.tsx:19-31`). Adds one new optional field, `scrollHint`, appending `"Press End to jump to latest"` when `true` — this is the spec's Scrolling section requirement (design spec line 112) with no equivalent in the old Ink StatusBar.

- [ ] **Step 1: Write the failing test**

```ts
// tests/widgets.test.ts
import { describe, it, expect } from "vitest";
import { renderStatusBar, formatTokens, formatElapsed } from "../src/ui/widgets/statusBar.js";
import { THEMES } from "../src/ui/theme.js";

const theme = THEMES.dark;

describe("formatTokens", () => {
  it("formats sub-1000 counts as raw tokens", () => {
    expect(formatTokens(500)).toBe("500 tok");
  });
  it("formats >=1000 counts in k with one decimal", () => {
    expect(formatTokens(12345)).toBe("12.3k tok");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(45_000)).toBe("45s");
  });
  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatElapsed(125_000)).toBe("2m 5s");
  });
  it("formats hour-plus durations as h/m/s", () => {
    expect(formatElapsed(3_725_000)).toBe("1h 2m 5s");
  });
});

describe("renderStatusBar", () => {
  it("joins segments with the middle dot in provider/model/mode order", () => {
    const row = renderStatusBar(
      { provider: "anthropic", model: "sonnet", mode: "default", cwd: "/repo" },
      theme, 80
    );
    expect(row).toContain("anthropic/sonnet");
    expect(row).toContain("default");
    expect(row).toContain("/repo");
    expect(row).toContain(" · ");
  });

  it("shows served-model arrow when servedModel differs from requested model", () => {
    const row = renderStatusBar(
      { provider: "anthropic", model: "sonnet", servedModel: "sonnet-5", mode: "default", cwd: "/repo" },
      theme, 80
    );
    expect(row).toContain("sonnet→sonnet-5");
  });

  it("includes git branch with a dirty marker when dirty", () => {
    const row = renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", gitBranch: "main", gitDirty: true },
      theme, 80
    );
    expect(row).toContain("⎇ main*");
  });

  it("omits token/cost/elapsed segments when not provided or zero", () => {
    const row = renderStatusBar({ provider: "a", mode: "default", cwd: "/r" }, theme, 80);
    expect(row).not.toContain("tok");
    expect(row).not.toContain("$");
  });

  it("appends the scroll hint when scrollHint is true", () => {
    const row = renderStatusBar({ provider: "a", mode: "default", cwd: "/r", scrollHint: true }, theme, 80);
    expect(row).toContain("Press End to jump to latest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/widgets.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/statusBar.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/statusBar.ts
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export interface StatusBarProps {
  provider: string;
  model?: string;
  servedModel?: string;
  mode: string;
  cwd: string;
  costUsd?: number;
  gitBranch?: string;
  gitDirty?: boolean;
  tokens?: number;
  contextPct?: number;
  elapsedMs?: number;
  scrollHint?: boolean;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function renderStatusBar(p: StatusBarProps, theme: Theme, width: number): string {
  const segments: string[] = [];
  const modelLabel =
    p.servedModel && p.model && p.servedModel !== p.model ? `${p.model}→${p.servedModel}` : p.servedModel ?? p.model;
  segments.push(p.provider + (modelLabel ? `/${modelLabel}` : ""));
  segments.push(p.mode);
  if (p.gitBranch) segments.push(`⎇ ${p.gitBranch}${p.gitDirty ? "*" : ""}`);
  if (p.tokens != null && p.tokens > 0) {
    segments.push(formatTokens(p.tokens) + (p.contextPct != null ? ` (${p.contextPct}%)` : ""));
  }
  if (p.costUsd && p.costUsd > 0) segments.push(`$${p.costUsd.toFixed(4)}`);
  if (p.elapsedMs != null && p.elapsedMs > 0) segments.push(formatElapsed(p.elapsedMs));
  segments.push(p.cwd);
  if (p.scrollHint) segments.push("Press End to jump to latest");
  const text = segments.join(" · ");
  const code = sgr(theme.muted);
  const line = code ? `${code}${text}${SGR_RESET}` : text;
  return line.length > width + code.length + SGR_RESET.length ? line : line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/widgets.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/statusBar.ts tests/widgets.test.ts
git commit -m "feat(ui): add pure renderStatusBar widget"
```

---

### Task 5: `widgets/workInd.ts` — pure WorkingIndicator row

**Files:**
- Create: `src/ui/widgets/workInd.ts`
- Modify: `tests/widgets.test.ts` (append)

**Interfaces:**
- Produces: `renderWorkInd(frame, label, elapsedMs, theme)` — used by Task 15/16.

Port of `WorkingIndicator.tsx`, minus the `useEffect` timer (the frame index is now driven by `App.tick()`).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/widgets.test.ts
import { renderWorkInd } from "../src/ui/widgets/workInd.js";

describe("renderWorkInd", () => {
  const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  it("cycles the spinner glyph by frame index", () => {
    expect(renderWorkInd(0, "Thinking", 0, THEMES.dark)).toContain(SPINNER[0]);
    expect(renderWorkInd(3, "Thinking", 0, THEMES.dark)).toContain(SPINNER[3]);
    expect(renderWorkInd(SPINNER.length, "Thinking", 0, THEMES.dark)).toContain(SPINNER[0]);
  });

  it("includes the label and elapsed seconds with the interrupt hint", () => {
    const row = renderWorkInd(0, "Running Read", 4200, THEMES.dark);
    expect(row).toContain("Running Read…");
    expect(row).toContain("(4s · Esc to interrupt)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/widgets.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/workInd.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/workInd.ts
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function renderWorkInd(frame: number, label: string, elapsedMs: number, theme: Theme): string {
  const glyph = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
  const seconds = Math.floor(elapsedMs / 1000);
  const accent = sgr(theme.accent);
  const muted = sgr(theme.muted);
  return `${accent}${glyph} ${label}… ${muted}(${seconds}s · Esc to interrupt)${SGR_RESET}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/widgets.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/workInd.ts tests/widgets.test.ts
git commit -m "feat(ui): add pure renderWorkInd widget"
```

---

### Task 6: `widgets/progress.ts` — pure ProgressBar row

**Files:**
- Create: `src/ui/widgets/progress.ts`
- Modify: `tests/widgets.test.ts` (append)

**Interfaces:**
- Produces: `renderProgress(label, pct, theme, width?)` — used by Task 15/16.

Port of `ProgressBar.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/widgets.test.ts
import { renderProgress } from "../src/ui/widgets/progress.js";

describe("renderProgress", () => {
  it("renders a filled/empty bar proportional to pct at the default width", () => {
    const row = renderProgress("Compacting", 50, THEMES.dark);
    expect(row).toContain("Compacting");
    expect(row).toContain("50%");
    expect(row).toContain("█".repeat(10));
    expect(row).toContain("░".repeat(10));
  });

  it("clamps pct to [0,100]", () => {
    expect(renderProgress("X", 150, THEMES.dark)).toContain("100%");
    expect(renderProgress("X", -10, THEMES.dark)).toContain("0%");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/widgets.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/progress.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/progress.ts
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export function renderProgress(label: string, pct: number, theme: Theme, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const accent = sgr(theme.accent);
  const muted = sgr(theme.muted);
  return `${accent}${label} ${muted}[${bar}] ${clamped}%${SGR_RESET}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/widgets.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/progress.ts tests/widgets.test.ts
git commit -m "feat(ui): add pure renderProgress widget"
```

---

### Task 7: `widgets/menu.ts` — pure suggestion menu rows

**Files:**
- Create: `src/ui/widgets/menu.ts`
- Modify: `tests/widgets.test.ts` (append)

**Interfaces:**
- Consumes: `Suggestion` from `../../commands/completion.js` (unchanged, non-UI).
- Produces: `MAX_ROWS = 8`, `visibleWindow(count, selected, max?)`, `renderMenu(suggestions, selected, theme, width)` — used by Task 10 (`inputBox.ts`), Task 11 (`overlay.ts`), Task 15.

Port of `SuggestionMenu.tsx`; `visibleWindow` is copied verbatim (`SuggestionMenu.tsx:11-15`) since `ResumePicker`/`ProjectPicker` reuse it too.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/widgets.test.ts
import { renderMenu, visibleWindow, MAX_ROWS } from "../src/ui/widgets/menu.js";

describe("visibleWindow", () => {
  it("returns the full range when count fits within max", () => {
    expect(visibleWindow(3, 1, 8)).toEqual({ start: 0, end: 3 });
  });
  it("windows around the selected index once count exceeds max", () => {
    expect(visibleWindow(20, 15, 8)).toEqual({ start: 8, end: 16 });
  });
  it("clamps the window to the end of the list", () => {
    expect(visibleWindow(20, 19, 8)).toEqual({ start: 12, end: 20 });
  });
  it("defaults max to MAX_ROWS", () => {
    expect(MAX_ROWS).toBe(8);
  });
});

describe("renderMenu", () => {
  const suggestions = [
    { label: "/clear", description: "Clear the session" },
    { label: "/compact", description: "Compact context" }
  ];
  it("marks the selected row with the pointer glyph and accent color", () => {
    const rows = renderMenu(suggestions, 0, THEMES.dark, 80);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("▶ ");
    expect(rows[0]).toContain("/clear");
    expect(rows[1]).not.toContain("▶ ");
  });
  it("caps rows at MAX_ROWS regardless of suggestion count", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `/cmd${i}`, description: "" }));
    expect(renderMenu(many, 10, THEMES.dark, 80)).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/widgets.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/menu.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/menu.ts
import type { Suggestion } from "../../commands/completion.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export const MAX_ROWS = 8;

export function visibleWindow(count: number, selected: number, max = MAX_ROWS): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - max + 1), count - max);
  return { start, end: start + max };
}

export function renderMenu(suggestions: Suggestion[], selected: number, theme: Theme, width: number): string[] {
  if (suggestions.length === 0) return [];
  const { start, end } = visibleWindow(suggestions.length, selected);
  const labelWidth = Math.max(...suggestions.map(s => s.label.length));
  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const s = suggestions[i];
    const isSelected = i === selected;
    const prefix = isSelected ? "▶ " : "  ";
    const label = s.label.padEnd(labelWidth + 2);
    const accent = isSelected ? sgr(theme.accent) : "";
    const muted = sgr(theme.muted);
    const left = accent ? `${accent}${prefix}${label}${SGR_RESET}` : `${prefix}${label}`;
    const desc = s.description ? ` ${muted}${s.description}${SGR_RESET}` : "";
    rows.push((left + desc).slice(0, width + (accent ? accent.length + SGR_RESET.length : 0) + (desc ? muted.length + SGR_RESET.length : 0)));
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/widgets.test.ts`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/menu.ts tests/widgets.test.ts
git commit -m "feat(ui): add pure renderMenu widget"
```

---

### Task 8: `input.ts` — streaming `KeyDecoder`

**Files:**
- Create: `src/ui/input.ts`
- Test: `tests/input.test.ts`

**Interfaces:**
- Produces: `Key` union, `class KeyDecoder { feed(chunk: Buffer): Key[] }` — used by Task 16 (`terminal.ts`), Task 17/18 (`nativeApp.ts`).

Implements the recognition table and 25ms Escape-vs-Alt disambiguation from spec's "Key Decoding" section verbatim.

- [ ] **Step 1: Write the failing test**

```ts
// tests/input.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyDecoder, type Key } from "../src/ui/input.js";

function b(s: string): Buffer { return Buffer.from(s, "binary"); }

describe("KeyDecoder", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("decodes enter, tab, backtab, backspace, delete", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\r"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\n"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\t"))).toEqual([{ t: "tab" }]);
    expect(d.feed(b("\x1b[Z"))).toEqual([{ t: "backtab" }]);
    expect(d.feed(b("\x7f"))).toEqual([{ t: "backspace" }]);
    expect(d.feed(b("\x1b[3~"))).toEqual([{ t: "delete" }]);
  });

  it("decodes both cursor-mode arrow variants", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[A"))).toEqual([{ t: "up" }]);
    expect(d.feed(b("\x1bOA"))).toEqual([{ t: "up" }]);
    expect(d.feed(b("\x1b[B"))).toEqual([{ t: "down" }]);
    expect(d.feed(b("\x1b[C"))).toEqual([{ t: "right" }]);
    expect(d.feed(b("\x1b[D"))).toEqual([{ t: "left" }]);
  });

  it("decodes home/end and pgup/pgdn variants", () => {
    const d = new KeyDecoder();
    for (const seq of ["\x1b[H", "\x1b[1~", "\x1bOH"]) expect(d.feed(b(seq))).toEqual([{ t: "home" }]);
    for (const seq of ["\x1b[F", "\x1b[4~", "\x1bOF"]) expect(d.feed(b(seq))).toEqual([{ t: "end" }]);
    expect(d.feed(b("\x1b[5~"))).toEqual([{ t: "pgup" }]);
    expect(d.feed(b("\x1b[6~"))).toEqual([{ t: "pgdn" }]);
  });

  it("decodes Ctrl-A..Z from bytes 0x01..0x1A", () => {
    const d = new KeyDecoder();
    expect(d.feed(Buffer.from([0x03]))).toEqual([{ t: "ctrl", ch: "c" }]);
    expect(d.feed(Buffer.from([0x02]))).toEqual([{ t: "ctrl", ch: "b" }]);
    expect(d.feed(Buffer.from([0x06]))).toEqual([{ t: "ctrl", ch: "f" }]);
    expect(d.feed(Buffer.from([0x01]))).toEqual([{ t: "ctrl", ch: "a" }]);
  });

  it("decodes printable characters", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("h"))).toEqual([{ t: "printable", ch: "h" }]);
  });

  it("decodes multiple keys delivered in one chunk", () => {
    const d = new KeyDecoder();
    const keys = d.feed(b("hi\r"));
    expect(keys).toEqual([{ t: "printable", ch: "h" }, { t: "printable", ch: "i" }, { t: "enter" }]);
  });

  it("decodes a bracketed paste payload as one event", () => {
    const d = new KeyDecoder();
    const keys = d.feed(b("\x1b[200~hello\nworld\x1b[201~"));
    expect(keys).toEqual([{ t: "paste", text: "hello\nworld" }]);
  });

  it("retains a partial escape sequence across feed() calls", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b["))).toEqual([]);
    expect(d.feed(b("A"))).toEqual([{ t: "up" }]);
  });

  it("emits esc after a 25ms timeout with no continuation bytes", () => {
    const d = new KeyDecoder();
    const onKeys = vi.fn();
    d.onTimeout = (keys: Key[]) => onKeys(keys);
    expect(d.feed(b("\x1b"))).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(onKeys).toHaveBeenCalledWith([{ t: "esc" }]);
  });

  it("parses a lone Escape as an escape-sequence prefix when continuation bytes arrive within 25ms", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b"))).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(d.feed(b("[A"))).toEqual([{ t: "up" }]);
  });

  it("decodes Alt+printable as a single alt key when a printable follows Escape directly in the same chunk", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1bx"))).toEqual([{ t: "alt", ch: "x" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/input.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/input.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/input.ts
export type Key =
  | { t: "printable"; ch: string }
  | { t: "paste"; text: string }
  | { t: "enter" }
  | { t: "tab" }
  | { t: "backtab" }
  | { t: "backspace" }
  | { t: "delete" }
  | { t: "esc" }
  | { t: "up" }
  | { t: "down" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "pgup" }
  | { t: "pgdn" }
  | { t: "ctrl"; ch: string }
  | { t: "alt"; ch: string };

const SEQUENCES: Record<string, Key> = {
  "\x1b[Z": { t: "backtab" },
  "\x1b[3~": { t: "delete" },
  "\x1b[A": { t: "up" }, "\x1bOA": { t: "up" },
  "\x1b[B": { t: "down" }, "\x1bOB": { t: "down" },
  "\x1b[C": { t: "right" }, "\x1bOC": { t: "right" },
  "\x1b[D": { t: "left" }, "\x1bOD": { t: "left" },
  "\x1b[H": { t: "home" }, "\x1b[1~": { t: "home" }, "\x1bOH": { t: "home" },
  "\x1b[F": { t: "end" }, "\x1b[4~": { t: "end" }, "\x1bOF": { t: "end" },
  "\x1b[5~": { t: "pgup" },
  "\x1b[6~": { t: "pgdn" }
};

const ESC_TIMEOUT_MS = 25;

export class KeyDecoder {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Test/production hook: called with keys resolved by the 25ms Escape timeout. */
  onTimeout: ((keys: Key[]) => void) | undefined;

  feed(chunk: Buffer): Key[] {
    this.clearTimer();
    this.pending += chunk.toString("binary");
    return this.drain();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private drain(): Key[] {
    const keys: Key[] = [];
    while (this.pending.length > 0) {
      const consumed = this.tryConsumeOne(keys);
      if (consumed === 0) break;
      this.pending = this.pending.slice(consumed);
    }
    if (this.pending === "\x1b") {
      this.timer = setTimeout(() => {
        this.pending = "";
        this.onTimeout?.([{ t: "esc" }]);
      }, ESC_TIMEOUT_MS);
    }
    return keys;
  }

  private tryConsumeOne(keys: Key[]): number {
    const s = this.pending;

    if (s.startsWith("\x1b[200~")) {
      const end = s.indexOf("\x1b[201~");
      if (end === -1) return 0; // wait for the rest of the paste
      keys.push({ t: "paste", text: s.slice(6, end) });
      return end + 6;
    }

    for (const [seq, key] of Object.entries(SEQUENCES)) {
      if (s.startsWith(seq)) { keys.push(key); return seq.length; }
    }

    if (s === "\x1b") return 0; // incomplete: could be Esc alone or a sequence prefix

    if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) return 0; // incomplete escape sequence

    if (s.startsWith("\x1b") && s.length >= 2) {
      keys.push({ t: "alt", ch: s[1] });
      return 2;
    }

    const ch = s[0];
    if (ch === "\r" || ch === "\n") { keys.push({ t: "enter" }); return 1; }
    if (ch === "\t") { keys.push({ t: "tab" }); return 1; }
    if (ch === "\x7f") { keys.push({ t: "backspace" }); return 1; }
    const code = ch.charCodeAt(0);
    if (code >= 0x01 && code <= 0x1a) {
      keys.push({ t: "ctrl", ch: String.fromCharCode(code + 96) });
      return 1;
    }
    keys.push({ t: "printable", ch });
    return 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/input.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/input.ts tests/input.test.ts
git commit -m "feat(ui): add streaming KeyDecoder with bracketed-paste and Escape-vs-Alt disambiguation"
```

---

### Task 9: `useGitStatus.ts` — port to plain function

**Files:**
- Modify: `src/ui/useGitStatus.ts`
- Test: `tests/useGitStatus.test.ts` (new; replaces `tests/useGitStatus.test.tsx`, which is deleted in this task)

**Interfaces:**
- Produces: `GitExec`, `GitStatus`, `class GitStatusPoller { start(): void; stop(): void; get status(): GitStatus }` — used by Task 17 (`nativeApp.ts`).

The React hook polled every 5s via `useEffect`/`setInterval` keyed on `[cwd, refreshKey]`. `nativeApp.ts` has no hook lifecycle, so this becomes a small stateful class the App owns: `refresh()` is called explicitly by `App` (on construction and whenever `turnCount` changes, mirroring the old `refreshKey` dependency), plus its own internal 5s timer for the periodic poll.

- [ ] **Step 1: Write the failing test**

```ts
// tests/useGitStatus.test.ts
import { describe, it, expect, vi } from "vitest";
import { GitStatusPoller, type GitExec } from "../src/ui/useGitStatus.js";

function fakeExec(branch: string, dirty: boolean): GitExec {
  return async (args: string[]) => {
    if (args[0] === "rev-parse") return branch;
    return dirty ? " M file.ts\n" : "";
  };
}

describe("GitStatusPoller", () => {
  it("starts with dirty:false and no branch before the first refresh", () => {
    const poller = new GitStatusPoller("/repo", fakeExec("main", false));
    expect(poller.status).toEqual({ dirty: false });
  });

  it("refresh() populates branch and dirty from the exec results", async () => {
    const poller = new GitStatusPoller("/repo", fakeExec("main", true));
    await poller.refresh();
    expect(poller.status).toEqual({ branch: "main", dirty: true });
  });

  it("refresh() on exec failure resets to dirty:false, branch undefined", async () => {
    const failing: GitExec = async () => { throw new Error("not a git repo"); };
    const poller = new GitStatusPoller("/repo", failing);
    await poller.refresh();
    expect(poller.status).toEqual({ dirty: false });
  });

  it("stop() clears the interval so no further polling occurs", () => {
    vi.useFakeTimers();
    const exec = vi.fn(fakeExec("main", false));
    const poller = new GitStatusPoller("/repo", exec);
    poller.start();
    poller.stop();
    vi.advanceTimersByTime(20_000);
    expect(exec).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/useGitStatus.test.ts`
Expected: FAIL with "GitStatusPoller is not exported"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/useGitStatus.ts
import { execFile } from "node:child_process";

export type GitExec = (args: string[], cwd: string) => Promise<string>;

export interface GitStatus {
  branch?: string;
  dirty: boolean;
}

const defaultExec: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const POLL_MS = 5000;

export class GitStatusPoller {
  private current: GitStatus = { dirty: false };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private cwd: string, private exec: GitExec = defaultExec) {}

  get status(): GitStatus {
    return this.current;
  }

  async refresh(): Promise<void> {
    try {
      const branch = (await this.exec(["rev-parse", "--abbrev-ref", "HEAD"], this.cwd)).trim();
      const porcelain = await this.exec(["status", "--porcelain", "-uno"], this.cwd);
      this.current = { branch: branch || undefined, dirty: porcelain.trim().length > 0 };
    } catch {
      this.current = { dirty: false };
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/useGitStatus.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Delete the obsolete React test**

```bash
git rm tests/useGitStatus.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/useGitStatus.ts tests/useGitStatus.test.ts
git commit -m "refactor(ui): port useGitStatus hook to a plain GitStatusPoller class"
```

---

### Task 10: `widgets/inputBox.ts` — stateful InputBox port

**Files:**
- Create: `src/ui/widgets/inputBox.ts`
- Test: `tests/inputBox.test.ts` (replaces `tests/inputBox.test.tsx`, deleted in this task)

**Interfaces:**
- Consumes: `Key` from `../input.js` (Task 8); `getSuggestions`, `applySuggestion`, `CompletionContext`, `Suggestion` from `../../commands/completion.js` (unchanged); `History` from `../../agent/history.js` (unchanged); `renderMenu`, `MAX_ROWS` from `./menu.js` (Task 7); `Theme` from `../theme.js`.
- Produces: `class InputBox`, `InputBoxRender` — used by Task 15 (`render.ts`), Task 17 (`nativeApp.ts`).

Direct port of `InputBox.tsx:162-233`'s `useInput` handler onto `handleKey(k: Key, disabled: boolean)`, replacing ink's `(input, key)` pair with the decoded `Key` union. All behaviors are preserved: backslash-continuation, `acceptIsNoop`, history-recall draft, `@`-token file-cache refresh, menu suppression after Escape, `Math.min(selected, menu.length-1)` accept. Because there is no React batching to rely on, `sync()`'s job (keeping `suggestions`/menu-row-count in lockstep with `value`/`cursor`) is done by simply recomputing everything synchronously inside `render()` — the old ink-specific "same-batch callback" mechanism (`onMenuRowsChange`/`onInputRowsChange`) is deleted outright since `App.recompute()` now calls `render()` synchronously right after every `handleKey()`, so there is no cross-frame lag to defend against at all.

- [ ] **Step 1: Write the failing test**

```ts
// tests/inputBox.test.ts
import { describe, it, expect, vi } from "vitest";
import { InputBox } from "../src/ui/widgets/inputBox.js";
import { History } from "../src/agent/history.js";
import { THEMES } from "../src/ui/theme.js";
import type { CompletionContext } from "../src/commands/completion.js";
import type { Key } from "../src/ui/input.js";

const theme = THEMES.dark;

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: { list: () => [], get: () => undefined } as never,
    providerNames: () => [],
    availableModels: () => [],
    listFiles: () => [],
    refreshFiles: () => {},
    ...overrides
  };
}

function type(box: InputBox, text: string): void {
  for (const ch of text) box.handleKey({ t: "printable", ch }, false);
}

describe("InputBox", () => {
  it("typing characters advances value and cursor, reflected in render()", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "hi");
    const r = box.render(theme, 80, false);
    expect(r.borderRows.join("\n") + r.contentRows.join("\n")).toContain("> hi");
  });

  it("backspace removes the character before the cursor", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "hi");
    box.handleKey({ t: "backspace" }, false);
    const r = box.render(theme, 80, false);
    expect(r.contentRows.join("\n")).toContain("> h");
    expect(r.contentRows.join("\n")).not.toContain("hi");
  });

  it("Enter with empty menu submits via onSubmit and clears the value", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    type(box, "hello");
    box.handleKey({ t: "enter" }, false);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("> ");
    expect(box.render(theme, 80, false).contentRows.join("\n")).not.toContain("hello");
  });

  it("a trailing backslash before Enter inserts a newline instead of submitting", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    type(box, "line1\\");
    box.handleKey({ t: "enter" }, false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("line1");
  });

  it("up-arrow with no menu open recalls the previous history entry and saves a draft", () => {
    const history = new History();
    history.add("earlier command");
    const box = new InputBox(ctx(), history);
    type(box, "draft text");
    box.handleKey({ t: "up" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("earlier command");
  });

  it("down-arrow past the most recent history entry restores the saved draft", () => {
    const history = new History();
    history.add("earlier command");
    const box = new InputBox(ctx(), history);
    type(box, "draft text");
    box.handleKey({ t: "up" }, false);
    box.handleKey({ t: "down" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("draft text");
  });

  it("typing '@' triggers a file-cache refresh exactly once per @-token session", () => {
    const refreshFiles = vi.fn();
    const box = new InputBox(ctx({ listFiles: () => ["a.ts", "b.ts"], refreshFiles }), new History());
    type(box, "@a");
    expect(refreshFiles).toHaveBeenCalledTimes(1);
    type(box, "b");
    expect(refreshFiles).toHaveBeenCalledTimes(1);
  });

  it("suggestion menu opens on '/' and reports rows via render().menuRows", () => {
    const registry = { list: () => [{ name: "clear", description: "Clear" }], get: () => undefined } as never;
    const box = new InputBox(ctx({ registry }), new History());
    type(box, "/");
    const r = box.render(theme, 80, false);
    expect(r.menuRows.length).toBeGreaterThan(0);
  });

  it("Escape suppresses an open menu until the value changes again", () => {
    const registry = { list: () => [{ name: "clear", description: "Clear" }], get: () => undefined } as never;
    const box = new InputBox(ctx({ registry }), new History());
    type(box, "/");
    expect(box.render(theme, 80, false).menuRows.length).toBeGreaterThan(0);
    box.handleKey({ t: "esc" }, false);
    expect(box.render(theme, 80, false).menuRows.length).toBe(0);
  });

  it("render() shows the working hint and no cursor glyph while disabled", () => {
    const box = new InputBox(ctx(), new History());
    const r = box.render(theme, 80, true);
    expect(r.hintRow).toContain("working… (Esc to interrupt)");
  });

  it("handleKey is a no-op while disabled", () => {
    const box = new InputBox(ctx(), new History());
    box.handleKey({ t: "printable", ch: "x" }, true);
    expect(box.render(theme, 80, true).contentRows.join("\n")).not.toContain("x");
  });

  it("handlePaste inserts the pasted text at the cursor without submitting", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "ab");
    box.handlePaste("PASTED", false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("abPASTED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inputBox.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/inputBox.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/inputBox.ts
import { getSuggestions, applySuggestion, type CompletionContext, type Suggestion } from "../../commands/completion.js";
import type { History } from "../../agent/history.js";
import type { Key } from "../input.js";
import { renderMenu } from "./menu.js";
import type { Theme } from "../theme.js";

export interface InputBoxRender {
  borderRows: string[];
  contentRows: string[];
  menuRows: string[];
  hintRow: string | null;
  totalRows: number;
}

export class InputBox {
  onSubmit: ((text: string) => void) | undefined;

  private value = "";
  private cursor = 0;
  private selected = 0;
  private draft: string | undefined;
  private suppressed = false;
  private hadAtToken = false;

  constructor(private completionCtx: CompletionContext, private history: History) {}

  private currentSuggestions(): Suggestion[] {
    if (this.suppressed) return [];
    return getSuggestions(this.value, this.cursor, this.completionCtx);
  }

  private setValue(nextValue: string, nextCursor: number): void {
    const changed = nextValue !== this.value;
    this.value = nextValue;
    this.cursor = Math.max(0, Math.min(nextCursor, nextValue.length));
    if (changed) {
      this.suppressed = false;
      this.selected = 0;
      const hasAt = /(^|\s)@[\w./-]*$/.test(nextValue.slice(0, this.cursor));
      if (hasAt && !this.hadAtToken) this.completionCtx.refreshFiles?.();
      this.hadAtToken = hasAt;
    }
  }

  private submit(): void {
    const current = this.value;
    if (current.endsWith("\\")) {
      this.setValue(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    this.setValue("", 0);
    this.draft = undefined;
    this.history.resetCursor();
    if (text) {
      this.history.add(text);
      this.onSubmit?.(text);
    }
  }

  private accept(suggestions: Suggestion[]): void {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    const r = applySuggestion(this.value, s);
    this.setValue(r.text, r.cursor);
  }

  private acceptIsNoop(suggestions: Suggestion[]): boolean {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    return applySuggestion(this.value, s).text === this.value.trimEnd();
  }

  handleKey(k: Key, disabled: boolean): void {
    if (disabled) return;
    if (k.t === "ctrl" || k.t === "alt") return;
    const menu = this.currentSuggestions();
    const menuOpen = menu.length > 0;

    if (k.t === "esc" && menuOpen) { this.suppressed = true; return; }
    if (k.t === "left") { this.setValue(this.value, this.cursor - 1); return; }
    if (k.t === "right") { this.setValue(this.value, this.cursor + 1); return; }
    if (k.t === "up") {
      if (menuOpen) { this.selected = (this.selected - 1 + menu.length) % menu.length; return; }
      if (this.draft === undefined) this.draft = this.value;
      const recalled = this.history.back();
      if (recalled !== undefined) this.setValue(recalled, recalled.length);
      return;
    }
    if (k.t === "down") {
      if (menuOpen) { this.selected = (this.selected + 1) % menu.length; return; }
      const recalled = this.history.forward();
      if (recalled !== undefined) {
        this.setValue(recalled, recalled.length);
      } else {
        this.setValue(this.draft ?? "", (this.draft ?? "").length);
        this.draft = undefined;
      }
      return;
    }
    if (k.t === "backspace" || k.t === "delete") {
      if (this.cursor > 0) this.setValue(this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor), this.cursor - 1);
      return;
    }
    if (k.t === "tab") { if (menuOpen) this.accept(menu); return; }
    if (k.t === "enter") {
      if (menuOpen && !this.acceptIsNoop(menu)) this.accept(menu);
      else this.submit();
      return;
    }
    if (k.t === "printable") {
      const ch = k.ch;
      if (ch >= " ") this.setValue(this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor), this.cursor + 1);
    }
  }

  handlePaste(text: string, disabled: boolean): void {
    if (disabled) return;
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        const m = this.currentSuggestions();
        if (m.length > 0 && !this.acceptIsNoop(m)) this.accept(m);
        else this.submit();
      } else if (ch >= " ") {
        this.setValue(this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor), this.cursor + 1);
      }
    }
  }

  render(theme: Theme, width: number, disabled: boolean): InputBoxRender {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const content = "> " + before + (disabled ? "" : "█") + after;
    const innerWidth = Math.max(1, width - 4);
    const wrapped = this.wrap(content, innerWidth);
    const borderRows = ["╭" + "─".repeat(Math.max(0, width - 2)) + "╮", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"];
    const hintRow = disabled ? "working… (Esc to interrupt)" : null;
    const suggestions = disabled ? [] : this.currentSuggestions();
    const menuRows = disabled ? [] : renderMenu(suggestions, Math.min(this.selected, Math.max(0, suggestions.length - 1)), theme, width);
    return {
      borderRows,
      contentRows: wrapped,
      menuRows,
      hintRow,
      totalRows: borderRows.length + wrapped.length + (hintRow ? 1 : 0) + menuRows.length
    };
  }

  private wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      let rest = line;
      if (rest.length === 0) { out.push(""); continue; }
      while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width); }
      out.push(rest);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inputBox.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Delete the obsolete Ink test**

```bash
git rm tests/inputBox.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/widgets/inputBox.ts tests/inputBox.test.ts
git commit -m "feat(ui): port InputBox to a framework-free stateful class"
```

---

### Task 11: `widgets/overlay.ts` — resume picker sub-mode

**Files:**
- Create: `src/ui/widgets/overlay.ts`
- Test: `tests/overlay.test.ts`

**Interfaces:**
- Consumes: `SessionEntry` from `../../agent/sessionIndex.js` (unchanged); `Key` from `../input.js`; `visibleWindow`, `MAX_ROWS` from `./menu.js`; `Theme`.
- Produces: `OverlayMode`, `class OverlayManager` with `mode`, `isOpen`, `openResume`, `close`, `handleKey`, `render` — extended by Task 12 (project) and Task 13 (permission). This task implements only the `resume` sub-mode plus the shared skeleton; later tasks add sibling sub-modes to the same file/class.

Port of `ResumePicker.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/overlay.test.ts
import { describe, it, expect, vi } from "vitest";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { THEMES } from "../src/ui/theme.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";

const theme = THEMES.dark;

function entries(n: number): SessionEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, cwd: "/repo", firstMessage: `msg ${i}`, timestamp: `t${i}`, provider: "anthropic"
  }));
}

describe("OverlayManager resume sub-mode", () => {
  it("starts closed", () => {
    const mgr = new OverlayManager();
    expect(mgr.mode).toBe("none");
    expect(mgr.isOpen).toBe(false);
  });

  it("openResume switches mode to resume and isOpen becomes true", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(2), () => {}, () => {});
    expect(mgr.mode).toBe("resume");
    expect(mgr.isOpen).toBe(true);
  });

  it("down/up arrows move the selection within bounds", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(3), () => {}, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" }); // clamps at last index
    const rows = mgr.render(theme, 80);
    expect(rows.some(r => r.includes("msg 2"))).toBe(true);
  });

  it("Enter calls onPick with the selected entry", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openResume(entries(2), onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith(entries(2)[1]);
  });

  it("Escape calls onCancel and closes the overlay", () => {
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openResume(entries(1), () => {}, onCancel);
    mgr.handleKey({ t: "esc" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("caps rendered rows at MAX_ROWS entries plus border/header regardless of list length", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(50), () => {}, () => {});
    const rows = mgr.render(theme, 80);
    expect(rows.length).toBeLessThanOrEqual(11);
  });

  it("shows a message and no crash when there are no entries", () => {
    const mgr = new OverlayManager();
    mgr.openResume([], () => {}, () => {});
    const rows = mgr.render(theme, 80);
    expect(rows.join("\n")).toContain("No past sessions");
  });

  it("close() resets mode to none", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(1), () => {}, () => {});
    mgr.close();
    expect(mgr.mode).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/widgets/overlay.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/widgets/overlay.ts
import type { SessionEntry } from "../../agent/sessionIndex.js";
import type { Key } from "../input.js";
import { visibleWindow, MAX_ROWS } from "./menu.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export type OverlayMode = "none" | "resume" | "project" | "permission";

interface ResumeState {
  entries: SessionEntry[];
  index: number;
  onPick: (e: SessionEntry) => void;
  onCancel: () => void;
}

export class OverlayManager {
  private _mode: OverlayMode = "none";
  private resumeState: ResumeState | undefined;

  get mode(): OverlayMode {
    return this._mode;
  }

  get isOpen(): boolean {
    return this._mode !== "none";
  }

  openResume(entries: SessionEntry[], onPick: (e: SessionEntry) => void, onCancel: () => void): void {
    this._mode = "resume";
    this.resumeState = { entries, index: 0, onPick, onCancel };
  }

  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
  }

  handleKey(k: Key): void {
    if (this._mode === "resume") this.handleResumeKey(k);
  }

  private handleResumeKey(k: Key): void {
    const s = this.resumeState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.entries.length - 1, s.index + 1); return; }
    if (k.t === "enter") {
      const entry = s.entries[s.index];
      if (entry) { const cb = s.onPick; this.close(); cb(entry); }
    }
  }

  render(theme: Theme, width: number): string[] {
    if (this._mode === "resume") return this.renderResume(theme, width);
    return [];
  }

  private renderResume(theme: Theme, width: number): string[] {
    const s = this.resumeState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    if (s.entries.length === 0) {
      return [`${muted}No past sessions. Press Esc to close.${SGR_RESET}`];
    }
    const { start, end } = visibleWindow(s.entries.length, s.index, MAX_ROWS);
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Resume a session (↑/↓, Enter, Esc)${SGR_RESET}`
    ];
    for (let i = start; i < end; i++) {
      const e = s.entries[i];
      const line = `${e.timestamp}  [${e.provider}]  ${e.firstMessage.slice(0, 60)}`;
      rows.push(i === s.index ? `\x1b[7m${line}\x1b[27m` : line);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/overlay.ts tests/overlay.test.ts
git commit -m "feat(ui): add OverlayManager with resume-picker sub-mode"
```

---

### Task 12: `widgets/overlay.ts` — project picker sub-mode

**Files:**
- Modify: `src/ui/widgets/overlay.ts`
- Modify: `tests/overlay.test.ts` (append)

**Interfaces:**
- Produces: `openProject(projects, currentCwd, onPick, onCancel)` added to `OverlayManager` — used by Task 17 (`nativeApp.ts`).

Port of `ProjectPicker.tsx`, including its special rule: pressing Enter on the entry equal to `currentCwd` cancels rather than picks.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/overlay.test.ts
describe("OverlayManager project sub-mode", () => {
  it("openProject switches mode to project", () => {
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", () => {}, () => {});
    expect(mgr.mode).toBe("project");
  });

  it("Enter on a different project calls onPick", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith("/b");
  });

  it("Enter on the current cwd's entry cancels instead of picking", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", onPick, onCancel);
    mgr.handleKey({ t: "enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("marks the current cwd entry with a bullet", () => {
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", () => {}, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    expect(rows.some(r => r.includes("●") && r.includes("/a"))).toBe(true);
  });

  it("shows a message when there are no recent projects", () => {
    const mgr = new OverlayManager();
    mgr.openProject([], "/a", () => {}, () => {});
    expect(mgr.render(THEMES.dark, 80).join("\n")).toContain("No recent projects");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL with "mgr.openProject is not a function"

- [ ] **Step 3: Write minimal implementation**

```ts
// modify src/ui/widgets/overlay.ts

// add near ResumeState:
interface ProjectState {
  projects: string[];
  currentCwd: string;
  index: number;
  onPick: (p: string) => void;
  onCancel: () => void;
}

// add field on OverlayManager:
  private projectState: ProjectState | undefined;

// add method on OverlayManager:
  openProject(projects: string[], currentCwd: string, onPick: (p: string) => void, onCancel: () => void): void {
    this._mode = "project";
    this.projectState = { projects, currentCwd, index: 0, onPick, onCancel };
  }

// extend close() to also clear projectState:
  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
    this.projectState = undefined;
  }

// extend handleKey():
  handleKey(k: Key): void {
    if (this._mode === "resume") this.handleResumeKey(k);
    else if (this._mode === "project") this.handleProjectKey(k);
  }

// add:
  private handleProjectKey(k: Key): void {
    const s = this.projectState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.projects.length - 1, s.index + 1); return; }
    if (k.t === "enter") {
      const p = s.projects[s.index];
      if (!p) return;
      if (p === s.currentCwd) { const cb = s.onCancel; this.close(); cb(); }
      else { const cb = s.onPick; this.close(); cb(p); }
    }
  }

// extend render():
  render(theme: Theme, width: number): string[] {
    if (this._mode === "resume") return this.renderResume(theme, width);
    if (this._mode === "project") return this.renderProject(theme, width);
    return [];
  }

// add:
  private renderProject(theme: Theme, width: number): string[] {
    const s = this.projectState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    if (s.projects.length === 0) {
      return [`${muted}No recent projects. Press Esc to close.${SGR_RESET}`];
    }
    const { start, end } = visibleWindow(s.projects.length, s.index, MAX_ROWS);
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Switch project (↑/↓, Enter, Esc)${SGR_RESET}`
    ];
    for (let i = start; i < end; i++) {
      const p = s.projects[i];
      const marker = p === s.currentCwd ? "● " : "  ";
      const line = marker + p;
      rows.push(i === s.index ? `\x1b[7m${line}\x1b[27m` : line);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/overlay.ts tests/overlay.test.ts
git commit -m "feat(ui): add project-picker sub-mode to OverlayManager"
```

---

### Task 13: `widgets/overlay.ts` — permission dialog sub-mode

**Files:**
- Modify: `src/ui/widgets/overlay.ts`
- Modify: `tests/overlay.test.ts` (append)

**Interfaces:**
- Consumes: `PermissionRequest` from `../../agent/session.js` (unchanged); `toolLabel` from `../transcript.js` (unchanged).
- Produces: `openPermission(request, onDecision)` added to `OverlayManager` — used by Task 17.

Port of `PermissionDialog.tsx`, including its `BASE_OPTIONS`/`FILE_OPTIONS` table and hotkeys `y`/`n`/`a`/`d`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/overlay.test.ts
describe("OverlayManager permission sub-mode", () => {
  const fileRequest = { toolName: "Edit", input: { file_path: "/a/b.ts" } };
  const bashRequest = { toolName: "Bash", input: { command: "ls" } };

  it("hotkey 'y' allows without remembering", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "y" }, "y");
    expect(onDecision).toHaveBeenCalledWith(true, undefined);
  });

  it("hotkey 'a' allows and remembers 'allow' (file-path requests only)", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "a" }, "a");
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("hotkey 'd' denies and remembers 'deny'", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "d" }, "d");
    expect(onDecision).toHaveBeenCalledWith(false, "deny");
  });

  it("Escape denies without remembering", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "esc" });
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("a non-file-path request only offers Yes/No, not Always/Never", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(bashRequest as never, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    const joined = rows.join("\n");
    expect(joined).not.toContain("Always for this directory");
  });

  it("arrow navigation plus Enter selects the currently highlighted option", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(bashRequest as never, onDecision);
    mgr.handleKey({ t: "right" });
    mgr.handleKey({ t: "enter" });
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("renders the tool label from transcript.toolLabel", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    expect(rows.join("\n")).toContain("Edit /a/b.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL with "mgr.openPermission is not a function"

- [ ] **Step 3: Write minimal implementation**

Note: `handleKey` needs a second optional `input: string` parameter for hotkey letters (arrow/Escape/Enter never carry one). Update the shared signature.

```ts
// modify src/ui/widgets/overlay.ts
import type { PermissionRequest } from "../../agent/session.js";
import { toolLabel } from "../transcript.js";

interface PermOption {
  label: string;
  hotkey: string;
  allow: boolean;
  rememberAs?: "allow" | "deny";
}

const BASE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "No (n)", hotkey: "n", allow: false }
];

const FILE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

interface PermissionState {
  request: PermissionRequest;
  options: PermOption[];
  selected: number;
  onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void;
}

// add field:
  private permissionState: PermissionState | undefined;

// add method:
  openPermission(request: PermissionRequest, onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void): void {
    this._mode = "permission";
    const hasFilePath = typeof request.input.file_path === "string";
    this.permissionState = { request, options: hasFilePath ? FILE_OPTIONS : BASE_OPTIONS, selected: 0, onDecision };
  }

// extend close():
  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
    this.projectState = undefined;
    this.permissionState = undefined;
  }

// change handleKey signature and extend:
  handleKey(k: Key, input?: string): void {
    if (this._mode === "resume") this.handleResumeKey(k);
    else if (this._mode === "project") this.handleProjectKey(k);
    else if (this._mode === "permission") this.handlePermissionKey(k, input);
  }

// add:
  private handlePermissionKey(k: Key, input?: string): void {
    const s = this.permissionState;
    if (!s) return;
    const decide = (opt: PermOption) => {
      const cb = s.onDecision;
      this.close();
      if (opt.rememberAs) cb(opt.allow, opt.rememberAs);
      else cb(opt.allow);
    };
    if (input) {
      const hot = s.options.find(o => o.hotkey === input.toLowerCase());
      if (hot) { decide(hot); return; }
    }
    if (k.t === "esc") { const cb = s.onDecision; this.close(); cb(false); return; }
    if (k.t === "left" || k.t === "up") { s.selected = (s.selected + s.options.length - 1) % s.options.length; return; }
    if (k.t === "right" || k.t === "down") { s.selected = (s.selected + 1) % s.options.length; return; }
    if (k.t === "enter") decide(s.options[s.selected]);
  }

// extend render():
  render(theme: Theme, width: number): string[] {
    if (this._mode === "resume") return this.renderResume(theme, width);
    if (this._mode === "project") return this.renderProject(theme, width);
    if (this._mode === "permission") return this.renderPermission(theme, width);
    return [];
  }

// add:
  private renderPermission(theme: Theme, width: number): string[] {
    const s = this.permissionState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const optionsLine = s.options
      .map((o, i) => (i === s.selected ? `\x1b[7m ${o.label} \x1b[27m` : ` ${o.label} `))
      .join("  ");
    return [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Permission required${SGR_RESET}`,
      toolLabel(s.request.toolName, s.request.input),
      optionsLine,
      "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"
    ];
  }
```

Also update Task 11/12's `handleResumeKey`/`handleProjectKey` call sites in `handleKey` — no change needed there since they ignore the new optional `input` param.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/overlay.ts tests/overlay.test.ts
git commit -m "feat(ui): add permission-dialog sub-mode to OverlayManager"
```

---

### Task 14: `term/terminal.ts` — TTY ownership + FakeTerminal

**Files:**
- Create: `src/ui/term/terminal.ts`
- Test: `tests/terminal.test.ts`

**Interfaces:**
- Consumes: `KeyDecoder` from `../input.js` (Task 8); ansi constants from `./ansi.js` (Task 1).
- Produces: `ITerminal`, `class Terminal`, `class FakeTerminal` — used by Task 16/17 (`nativeApp.ts`) and Task 19 (`cli.ts`).

Implements the non-TTY fallback from the spec's Key Decoding section: when `process.stdin.isTTY === false`, skip raw mode, never construct a `KeyDecoder`, and instead read stdin line-by-line, synthesizing each finished line as `{ t: "paste"; text: line }`. `FakeTerminal` never touches `process.stdin`/`stdout` — it exists purely so `App` can be constructed in tests without monkey-patching, per spec's Testing section.

- [ ] **Step 1: Write the failing test**

```ts
// tests/terminal.test.ts
import { describe, it, expect } from "vitest";
import { FakeTerminal } from "../src/ui/term/terminal.js";

describe("FakeTerminal", () => {
  it("is never a TTY", () => {
    const t = new FakeTerminal();
    expect(t.isTTY).toBe(false);
  });

  it("reports a default size", () => {
    const t = new FakeTerminal();
    expect(t.size()).toEqual({ rows: 24, columns: 80 });
  });

  it("accepts a custom size", () => {
    const t = new FakeTerminal({ rows: 10, columns: 40 });
    expect(t.size()).toEqual({ rows: 10, columns: 40 });
  });

  it("captures every write() call's string", () => {
    const t = new FakeTerminal();
    t.write("frame one");
    t.write("frame two");
    expect(t.writes).toEqual(["frame one", "frame two"]);
  });

  it("onLine delivers synthesized lines fed via feedLine (test helper)", () => {
    const t = new FakeTerminal();
    const lines: string[] = [];
    t.onLine(line => lines.push(line));
    t.feedLine("hello");
    expect(lines).toEqual(["hello"]);
  });

  it("onResize callback fires when resize() (test helper) is called", () => {
    const t = new FakeTerminal();
    let fired = false;
    t.onResize(() => { fired = true; });
    t.resize({ rows: 30, columns: 100 });
    expect(fired).toBe(true);
    expect(t.size()).toEqual({ rows: 30, columns: 100 });
  });

  it("cleanup() is idempotent and safe to call multiple times", () => {
    const t = new FakeTerminal();
    expect(() => { t.cleanup(); t.cleanup(); }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terminal.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/term/terminal.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/term/terminal.ts
import { createInterface } from "node:readline";
import { KeyDecoder, type Key } from "../input.js";
import { ALT_SCREEN_ON, ALT_SCREEN_OFF, BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF, CURSOR_HIDE, CURSOR_SHOW } from "./ansi.js";

export interface ITerminal {
  isTTY: boolean;
  size(): { rows: number; columns: number };
  write(s: string): void;
  onKeys(cb: (keys: Key[]) => void): void;
  onResize(cb: () => void): void;
  onLine(cb: (line: string) => void): void;
  cleanup(): void;
}

export class Terminal implements ITerminal {
  isTTY: boolean;
  private decoder: KeyDecoder | undefined;
  private keysCb: ((keys: Key[]) => void) | undefined;
  private cleaned = false;

  constructor() {
    this.isTTY = process.stdin.isTTY === true;
    if (this.isTTY) {
      process.stdout.write(ALT_SCREEN_ON + BRACKETED_PASTE_ON + CURSOR_HIDE);
      process.stdin.setRawMode(true);
      this.decoder = new KeyDecoder();
      this.decoder.onTimeout = keys => this.keysCb?.(keys);
      process.stdin.on("data", (chunk: Buffer) => {
        const keys = this.decoder!.feed(chunk);
        if (keys.length > 0) this.keysCb?.(keys);
      });
      process.stdin.resume();
    }
  }

  size(): { rows: number; columns: number } {
    return { rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 };
  }

  write(s: string): void {
    process.stdout.write(s);
  }

  onKeys(cb: (keys: Key[]) => void): void {
    this.keysCb = cb;
  }

  onResize(cb: () => void): void {
    process.stdout.on("resize", cb);
  }

  onLine(cb: (line: string) => void): void {
    if (this.isTTY) return;
    const rl = createInterface({ input: process.stdin });
    rl.on("line", cb);
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(BRACKETED_PASTE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
    }
  }
}

export class FakeTerminal implements ITerminal {
  isTTY = false;
  writes: string[] = [];
  private sz: { rows: number; columns: number };
  private lineCb: ((line: string) => void) | undefined;
  private resizeCb: (() => void) | undefined;

  constructor(size: { rows: number; columns: number } = { rows: 24, columns: 80 }) {
    this.sz = size;
  }

  size(): { rows: number; columns: number } {
    return this.sz;
  }

  write(s: string): void {
    this.writes.push(s);
  }

  onKeys(): void {
    // Tests inject Key[] lists directly into App; FakeTerminal never decodes stdin.
  }

  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  cleanup(): void {
    // no-op: FakeTerminal never touches real stdin/stdout
  }

  /** Test helper: simulate a finished non-TTY input line. */
  feedLine(line: string): void {
    this.lineCb?.(line);
  }

  /** Test helper: simulate a terminal resize. */
  resize(size: { rows: number; columns: number }): void {
    this.sz = size;
    this.resizeCb?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terminal.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/terminal.ts tests/terminal.test.ts
git commit -m "feat(ui): add Terminal (raw TTY owner) and FakeTerminal test double"
```

---

### Task 15: `term/render.ts` — frame composition

**Files:**
- Create: `src/ui/term/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `Buffer` (Task 3), `renderStatusBar`/`StatusBarProps` (Task 4), `renderWorkInd` (Task 5), `renderProgress` (Task 6), `InputBoxRender` (Task 10), `tailForHeight` from `../streamTail.js` (unchanged), `textRows`-equivalent (this task computes row counts via `.length` on `wrapText`-derived arrays rather than reusing `bottomFill.ts`, which is deleted — see Task 19), `CLEAR_AND_HOME`, `cursorTo` from `./ansi.js`.
- Produces: `BottomState`, `render(buffer, scrollOffset, bottom, theme, size)` — used by Task 17 (`nativeApp.ts`).

This is **the test that locks the pinned-footer property the whole rewrite exists to deliver** (spec Testing, Tier 3).

- [ ] **Step 1: Write the failing test**

```ts
// tests/render.test.ts
import { describe, it, expect } from "vitest";
import { render, type BottomState } from "../src/ui/term/render.js";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";
import type { DisplayItem } from "../src/ui/transcript.js";

const theme = THEMES.dark;

function emptyInputRender() {
  return { borderRows: ["╭─╮", "╰─╯"], contentRows: ["> "], menuRows: [], hintRow: null, totalRows: 3 };
}

function baseBottom(overrides: Partial<BottomState> = {}): BottomState {
  return {
    overlay: "none",
    streaming: false,
    streamingText: "",
    activeTool: undefined,
    compactPct: undefined,
    scrollOffset: null,
    inputRender: emptyInputRender(),
    overlayRows: [],
    statusBarProps: { provider: "anthropic", mode: "default", cwd: "/repo" },
    workIndFrame: 0,
    workStartedAt: 0,
    ...overrides
  };
}

describe("render", () => {
  it("pins the StatusBar to the very last row", () => {
    const buf = new Buffer();
    const out = render(buf, null, baseBottom(), theme, { rows: 24, columns: 80 });
    expect(out).toContain("\x1b[24;1H");
    const lastRowIdx = out.lastIndexOf("\x1b[24;1H");
    const tail = out.slice(lastRowIdx);
    expect(tail).toContain("anthropic");
    expect(tail).toContain("/repo");
  });

  it("leaves no filler gap: the footer sits directly below the input box with no blank rows in between", () => {
    const buf = new Buffer();
    const out = render(buf, null, baseBottom(), theme, { rows: 10, columns: 80 });
    // input box is 3 rows (2 border + 1 content), status bar is 1 row directly after
    const inputTopRow = 10 - 1 /*status*/ - 3 /*input*/ + 1;
    expect(out).toContain(`\x1b[${inputTopRow};1H`);
  });

  it("caps a tall streaming preview to fit above the fixed-height footer region", () => {
    const buf = new Buffer();
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = render(buf, null, baseBottom({ streaming: true, streamingText: longText }), theme, { rows: 24, columns: 80 });
    expect(out).toContain("\x1b[24;1H"); // footer still pinned even with a huge stream
    expect(out).not.toContain("line 0"); // earliest lines are tail-capped away
    expect(out).toContain("line 49");
  });

  it("renders the open overlay above the input box instead of the input box", () => {
    const buf = new Buffer();
    const out = render(buf, null, baseBottom({ overlay: "resume", overlayRows: ["OVERLAY_MARKER"] }), theme, { rows: 24, columns: 80 });
    expect(out).toContain("OVERLAY_MARKER");
  });

  it("moving scrollOffset changes the transcript window without moving the footer row", () => {
    const buf = new Buffer();
    for (let i = 0; i < 40; i++) buf.append({ kind: "notice", text: `line${i}` } satisfies DisplayItem);
    const bottomTail = render(buf, null, baseBottom(), theme, { rows: 24, columns: 80 });
    const bottomScrolled = render(buf, 0, baseBottom({ scrollOffset: 0 }), theme, { rows: 24, columns: 80 });
    expect(bottomTail).toContain("\x1b[24;1H");
    expect(bottomScrolled).toContain("\x1b[24;1H");
    expect(bottomTail).not.toEqual(bottomScrolled);
  });

  it("begins every frame with a full clear and cursor home", () => {
    const buf = new Buffer();
    const out = render(buf, null, baseBottom(), theme, { rows: 24, columns: 80 });
    expect(out.startsWith("\x1b[2J\x1b[H")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/term/render.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/term/render.ts
import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { CLEAR_AND_HOME, cursorTo } from "./ansi.js";
import type { Theme } from "../theme.js";

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  activeTool?: string;
  compactPct?: number;
  scrollOffset: number | null;
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}

export function render(
  buffer: Buffer,
  scrollOffset: number | null,
  bottom: BottomState,
  theme: Theme,
  size: { rows: number; columns: number }
): string {
  const { rows, columns } = size;

  // Footer region, built bottom-up so its total height is known before the
  // transcript region's height is computed.
  const footerRows: string[] = [];
  footerRows.push(renderStatusBar({ ...bottom.statusBarProps, scrollHint: scrollOffset !== null }, theme, columns));
  if (bottom.overlay !== "none") {
    footerRows.unshift(...bottom.overlayRows);
  } else {
    footerRows.unshift(...bottom.inputRender.menuRows);
    if (bottom.inputRender.hintRow !== null) footerRows.unshift(bottom.inputRender.hintRow);
    footerRows.unshift(...bottom.inputRender.contentRows);
    footerRows.unshift(...bottom.inputRender.borderRows);
  }
  if (bottom.compactPct !== undefined) footerRows.unshift(renderProgress("Compacting", bottom.compactPct, theme, 20));
  if (bottom.streaming) footerRows.unshift(renderWorkInd(bottom.workIndFrame, bottom.activeTool ? `Running ${bottom.activeTool}` : "Thinking", Date.now() - bottom.workStartedAt, theme));
  if (bottom.streamingText !== "") {
    const streamTailCap = Math.max(3, rows - footerRows.length - 3);
    const tail = tailForHeight(bottom.streamingText, streamTailCap, columns);
    footerRows.unshift(...tail.split("\n"));
  }

  const footerHeight = Math.min(rows, footerRows.length);
  const visibleFooter = footerRows.slice(footerRows.length - footerHeight);
  const transcriptHeight = Math.max(0, rows - footerHeight);

  const { rows: transcriptRows } = buffer.visibleWindow(scrollOffset, transcriptHeight, columns, theme);

  const out: string[] = [CLEAR_AND_HOME];
  transcriptRows.forEach((row, i) => {
    out.push(cursorTo(i + 1, 1) + row);
  });
  const footerStartRow = rows - footerHeight + 1;
  visibleFooter.forEach((row, i) => {
    out.push(cursorTo(footerStartRow + i, 1) + row);
  });
  return out.join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/render.ts tests/render.test.ts
git commit -m "feat(ui): add render() frame composer with structurally pinned footer"
```

---

### Task 16: `nativeApp.ts` skeleton, message handling, non-TTY wiring

**Files:**
- Create: `src/ui/nativeApp.ts` (temporary filename; the legacy Ink orchestrator already occupies `src/ui/App.tsx`, which compiles to the same `dist/ui/App.js` output path — see Follow-up work for the eventual rename to `App.ts` once the legacy file is deleted)
- Test: `tests/app.test.ts` (replaces `tests/app.test.tsx`, deleted in Task 18)

**Interfaces:**
- Consumes: everything produced by Tasks 1–15 plus unchanged files: `EngineMessage` (`../engine/messages.js`), `AgentSession`/`PermissionMode`/`PermissionRequest` (`../agent/session.js`), `History` (`../agent/history.js`), `ProviderConfig` (`../agent/providers.js`), `SessionIndex` (`../agent/sessionIndex.js`), `PermissionStore` (`../agent/permissionStore.js`), `buildRegistry`/`parseSlash`/`CommandContext` (`../commands/*`), `FileIndex`/`CompletionContext` (`../commands/*`), `toDisplayItems`/`streamDelta` (`./transcript.js`), `fetchModels` (`../agent/models.js`), `loadMcpServers`/`formatMcpStatus` (`../agent/mcp.js`), `loadSkills`/`formatSkillList`/`Skill` (`../agent/skills.js`), `mergeSkillCommands` (`../commands/skillCommands.js`), `THEMES`/`loadThemeName`/`saveThemeName` (`./theme.js`), `loadWelcome` (`./welcome.js`), `VERSION` (`../version.js`), `recentProjects`/`resolveProjectPath` (`../commands/projectPath.js`), `GitStatusPoller` (`./useGitStatus.js`, Task 9).
- Produces: `class App` with `constructor(props, terminal)`, `run()`, `handleMessage(msg)`, `tick()`, `recompute()` — key routing (`handleKey`/`handleKeys`) is added in Task 17.

This task ports `App.tsx`'s state (minus the `<Static>`/`measureElement`/filler machinery, which has no equivalent — every frame is a full repaint now), `handleMessage` (`App.tsx:169-204`), session lifecycle (`createSession`/`restartSession`/`recordSession`, `App.tsx:211-247, 282-288`), `runAutoCompact` (`App.tsx:148-167`), and the `CommandContext` (`App.tsx:290-356`). Key routing is deferred to Task 17 to keep this task's diff reviewable on its own.

- [ ] **Step 1: Write the failing test**

```ts
// tests/app.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../src/ui/nativeApp.js";
import { FakeTerminal } from "../src/ui/term/terminal.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { fetchModels } from "../src/agent/models.js";

vi.mock("../src/agent/models.js", () => ({
  fetchModels: vi.fn().mockResolvedValue(["model-a", "model-b"])
}));
vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));
vi.mock("../src/engine/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/engine/loop.js")>("../src/engine/loop.js");
  function SpiedEngineLoop(this: unknown, opts: ConstructorParameters<typeof actual.EngineLoop>[0]) {
    return new actual.EngineLoop(opts);
  }
  return { ...actual, EngineLoop: vi.fn(SpiedEngineLoop as unknown as typeof actual.EngineLoop) };
});

import { makeClient } from "../src/engine/api.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
type Event = Record<string, unknown>;

function fakeClient(turns: Event[][]) {
  let call = 0;
  return {
    create: vi.fn(async function* () {
      const events = turns[Math.min(call, turns.length - 1)];
      call++;
      for (const e of events) yield e;
    })
  };
}

function textTurn(text: string, usage?: Record<string, number>): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage ?? {} }
  ];
}

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
});

function makeApp(turns: Event[][]) {
  vi.mocked(makeClient).mockReturnValue(fakeClient(turns) as never);
  const terminal = new FakeTerminal({ rows: 24, columns: 80 });
  const app = new App({
    cwd: "/repo",
    providers: { anthropic: {} },
    initialProvider: "anthropic",
    sessionIndex: new SessionIndex()
  }, terminal);
  return { app, terminal };
}

describe("App", () => {
  it("appends a user message to the buffer and renders a frame that shows it", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("> hello");
  });

  it("commits the assistant reply to the buffer on result", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("hi there");
  });

  it("updates cost and token StatusBar segments from usage on result", async () => {
    const { app, terminal } = makeApp([textTurn("ok", { input_tokens: 100, output_tokens: 50 })]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("tok");
  });

  it("every emitted frame's last written row is the StatusBar", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    for (const frame of terminal.writes) {
      expect(frame).toContain("\x1b[24;1H");
    }
  });

  it("auto-compact fires when context usage reaches 80%", async () => {
    const { app } = makeApp([textTurn("ok", { input_tokens: 160_000, output_tokens: 0 })]);
    const compactSpy = vi.fn();
    app.onAutoCompactForTest = compactSpy;
    void app.run();
    app.submitForTest("hello");
    await wait();
    expect(compactSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL with "Cannot find module '../src/ui/nativeApp.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/nativeApp.ts
import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, type DisplayItem } from "./transcript.js";
import { fetchModels } from "../agent/models.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { loadWelcome } from "./welcome.js";
import { VERSION } from "../version.js";
import { recentProjects, resolveProjectPath } from "../commands/projectPath.js";
import { GitStatusPoller } from "./useGitStatus.js";
import { Buffer } from "./buffer.js";
import { InputBox } from "./widgets/inputBox.js";
import { OverlayManager } from "./widgets/overlay.js";
import { render, type BottomState } from "./term/render.js";
import type { ITerminal } from "./term/terminal.js";
import type { Key } from "./input.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  initialModel?: string;
  initialMode?: PermissionMode;
  resume?: string;
  sessionIndex: SessionIndex;
  openResumeOnStart?: boolean;
  onSwitchProject?: (path: string) => string | undefined;
  switchedFrom?: string;
}

type Phase = "idle" | "streaming" | "permission";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
const CONTEXT_WINDOW = 200_000;
const AUTO_COMPACT_THRESHOLD_PCT = 80;

export class App {
  /** Test hook: called whenever auto-compact fires. */
  onAutoCompactForTest: (() => void) | undefined;

  private buffer = new Buffer();
  private inputBox: InputBox;
  private overlay = new OverlayManager();
  private theme = THEMES[loadThemeName()] ?? THEMES.dark;

  private phase: Phase = "idle";
  private streamText = "";
  private activeTool: string | undefined;
  private providerName: string;
  private model: string | undefined;
  private servedModel: string | undefined;
  private mode: PermissionMode;
  private permissionQueue: PermissionRequest[] = [];
  private cost = 0;
  private tokens = 0;
  private contextPct: number | undefined;
  private compactPct: number | undefined;
  private turnCount = 0;
  private startedAt = Date.now();
  private workStartedAt = 0;
  private workIndFrame = 0;
  private scrollOffset: number | null = null;

  private firstMessage: string | undefined;
  private session: AgentSession | undefined;
  private lastCtrlCAt = 0;
  private history = new History();
  private permissionStore: PermissionStore;
  private registry = buildRegistry();
  private skills: Skill[] = [];
  private fileIndex: FileIndex;
  private availableModels: string[] = [];
  private mcpServers: Record<string, Record<string, unknown>> = {};
  private autoCompacting = false;
  private git: GitStatusPoller;
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  private ctx: CommandContext;
  private completionCtx: CompletionContext;

  constructor(private props: AppProps, private terminal: ITerminal) {
    this.providerName = props.initialProvider;
    this.model = this.modelFor(props.initialProvider);
    this.mode = props.initialMode ?? "default";
    this.permissionStore = new PermissionStore(props.cwd);
    this.fileIndex = new FileIndex(props.cwd);
    this.git = new GitStatusPoller(props.cwd);
    this.inputBox = new InputBox(this.completionCtxRef(), this.history);
    this.inputBox.onSubmit = text => this.handleSubmit(text);
    this.completionCtx = this.completionCtxRef();
    this.ctx = this.buildCommandContext();

    const welcome = loadWelcome({ version: VERSION, provider: props.initialProvider, model: this.model });
    if (welcome) this.buffer.append({ kind: "notice", text: welcome });
    if (props.switchedFrom) this.buffer.append({ kind: "notice", text: `Switched project to ${props.cwd}` });

    if (props.openResumeOnStart) {
      this.overlay.openResume(
        props.sessionIndex.list(),
        e => this.pickResume(e),
        () => this.overlay.close()
      );
    }
  }

  private modelFor(name: string): string | undefined {
    return (name === this.props.initialProvider ? this.props.initialModel : undefined) ?? this.props.providers[name]?.model;
  }

  private completionCtxRef(): CompletionContext {
    return {
      registry: this.registry,
      providerNames: () => Object.keys(this.props.providers),
      availableModels: () => this.availableModels,
      listFiles: () => this.fileIndex.list(),
      refreshFiles: () => this.fileIndex.refresh()
    };
  }

  private notice(text: string): void {
    this.buffer.append({ kind: "notice", text });
  }

  private async runAutoCompact(): Promise<void> {
    if (this.autoCompacting) return;
    this.autoCompacting = true;
    this.onAutoCompactForTest?.();
    this.compactPct = 0;
    this.recompute();
    try {
      const estimatedTokens = await this.session?.compact(pct => { this.compactPct = pct; this.recompute(); });
      if (typeof estimatedTokens === "number") {
        this.contextPct = Math.min(100, Math.round((estimatedTokens / CONTEXT_WINDOW) * 100));
      }
      this.notice("Context was getting full — compacted automatically.");
    } catch (err) {
      this.buffer.append({ kind: "error", text: `Auto-compact failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      this.compactPct = undefined;
      this.autoCompacting = false;
      this.recompute();
    }
  }

  handleMessage(msg: EngineMessage): void {
    const served = (msg as { message?: { model?: string } }).message?.model;
    if (served) this.servedModel = served;
    const delta = streamDelta(msg);
    if (delta) { this.streamText += delta; this.recompute(); return; }
    const mapped = toDisplayItems(msg);
    for (const item of mapped) this.buffer.append(item);
    if (mapped.some(i => i.kind === "assistant")) { this.streamText = ""; this.activeTool = undefined; }
    const lastTool = [...mapped].reverse().find((i): i is Extract<DisplayItem, { kind: "tool" }> => i.kind === "tool");
    if (lastTool) this.activeTool = lastTool.label.split(" ")[0];

    const t = (msg as { type: string }).type;
    if (t === "result") {
      if (this.streamText) {
        this.buffer.append({ kind: "assistant", text: this.streamText });
        this.streamText = "";
      }
      this.activeTool = undefined;
      this.phase = "idle";
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") this.cost += cost;
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        this.tokens += input + output;
        const pct = Math.min(100, Math.round((input / CONTEXT_WINDOW) * 100));
        this.contextPct = pct;
        if (pct >= AUTO_COMPACT_THRESHOLD_PCT) void this.runAutoCompact();
      }
      this.turnCount += 1;
      this.git.refresh().then(() => this.recompute());
    }
    this.recompute();
  }

  private refreshSkills(): void {
    this.skills = loadSkills(this.props.cwd);
    this.registry = mergeSkillCommands(buildRegistry(), this.skills);
  }

  private createSession(name: string, resume?: string, modeOverride?: PermissionMode): AgentSession {
    this.availableModels = [];
    void fetchModels(this.props.providers[name] ?? {}).then(models => { this.availableModels = models; });
    this.mcpServers = loadMcpServers(this.props.cwd);
    this.refreshSkills();
    const session = new AgentSession({
      providerName: name,
      provider: this.props.providers[name],
      model: this.modelFor(name),
      permissionMode: modeOverride ?? this.mode,
      resume,
      cwd: this.props.cwd,
      mcpServers: this.mcpServers,
      onMessage: msg => this.handleMessage(msg),
      onPermissionRequest: req => {
        this.permissionQueue.push(req);
        this.phase = "permission";
        this.openNextPermission();
      },
      onSessionId: id => { if (this.firstMessage) this.recordSession(id, name); }
    });
    session.start();
    return session;
  }

  private openNextPermission(): void {
    const active = this.permissionQueue[0];
    if (!active) return;
    this.overlay.openPermission(active, (allow, rememberAs) => this.decidePermission(allow, rememberAs));
    this.recompute();
  }

  private decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
    const active = this.permissionQueue[0];
    if (rememberAs && active && typeof active.input.file_path === "string") {
      try {
        this.permissionStore.remember(active.toolName, active.input.file_path, rememberAs);
      } catch (err) {
        this.buffer.append({ kind: "error", text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    active?.resolve(allow);
    this.permissionQueue = this.permissionQueue.slice(1);
    if (this.permissionQueue.length === 0) this.phase = "streaming";
    else this.openNextPermission();
    this.recompute();
  }

  private recordSession(id: string, provider: string): void {
    this.props.sessionIndex.record({
      id, cwd: this.props.cwd, firstMessage: this.firstMessage ?? "", timestamp: new Date().toISOString(), provider
    });
  }

  private async restartSession(name: string, resume?: string, modeOverride?: PermissionMode): Promise<void> {
    await this.session?.dispose();
    this.firstMessage = undefined;
    this.session = this.createSession(name, resume, modeOverride);
    this.model = this.modelFor(name);
    this.servedModel = undefined;
  }

  private pickResume(e: { id: string; provider: string }): void {
    this.overlay.close();
    this.buffer.clear();
    const provider = this.props.providers[e.provider] ? e.provider : this.providerName;
    this.providerName = provider;
    this.model = this.props.providers[provider]?.model;
    void this.restartSession(provider, e.id);
  }

  private buildCommandContext(): CommandContext {
    return {
      notice: text => this.notice(text),
      clearSession: async () => {
        this.buffer.clear();
        this.streamText = "";
        this.activeTool = undefined;
        await this.restartSession(this.providerName);
        this.recompute();
      },
      setModel: async m => { await this.session?.setModel(m); this.model = m; this.servedModel = undefined; this.recompute(); },
      availableModels: () => this.availableModels,
      currentModel: () => this.model,
      setPermissionMode: async m => {
        const pm = m as PermissionMode;
        await this.session?.setPermissionMode(pm);
        this.mode = pm;
        this.recompute();
      },
      switchProvider: async name => {
        if (!this.props.providers[name]) {
          this.notice(`Unknown provider: ${name}. Providers: ${Object.keys(this.props.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
          return;
        }
        const previous = this.providerName;
        try {
          await this.restartSession(name);
          this.providerName = name;
          this.model = this.modelFor(name);
          this.notice(`Provider: ${name}`);
        } catch (err) {
          this.notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
          await this.restartSession(previous);
        }
        this.recompute();
      },
      compact: async onProgress => {
        const estimatedTokens = await this.session?.compact(onProgress);
        if (typeof estimatedTokens === "number") this.contextPct = Math.min(100, Math.round((estimatedTokens / CONTEXT_WINDOW) * 100));
        return estimatedTokens;
      },
      setCompactProgress: pct => { this.compactPct = pct; this.recompute(); },
      openResumePicker: () => {
        this.overlay.openResume(this.props.sessionIndex.list(), e => this.pickResume(e), () => { this.overlay.close(); this.recompute(); });
        this.recompute();
      },
      costSummary: () => `Session cost: $${this.cost.toFixed(4)}`,
      providerNames: () => Object.keys(this.props.providers),
      exit: () => { void this.session?.dispose(); this.stop(); },
      listPermissionRules: () => {
        const rules = this.permissionStore.list();
        if (rules.length === 0) return "No permission rules.";
        return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir}`).join("\n");
      },
      clearPermissionRules: () => this.permissionStore.clear(),
      mcpStatus: async () =>
        formatMcpStatus(Object.keys(this.mcpServers), (await this.session?.mcpStatus()) ?? [], this.session?.tools ?? []),
      sendPrompt: text => this.sendUserMessage(text),
      listSkills: () => formatSkillList(this.skills),
      reloadSkills: () => this.refreshSkills(),
      setTheme: name => { this.theme = THEMES[name] ?? this.theme; saveThemeName(name); this.recompute(); },
      listThemes: () => Object.keys(THEMES).map(n => `${n === loadThemeName() ? "●" : " "} ${n}`).join("\n"),
      switchProject: path => {
        if (!this.props.onSwitchProject) { this.notice("Project switching is not available."); return; }
        const err = this.props.onSwitchProject(path);
        if (err) this.notice(err);
      },
      openProjectPicker: () => {
        this.overlay.openProject(
          recentProjects(this.props.sessionIndex.list(), this.props.cwd),
          this.props.cwd,
          p => {
            const result = resolveProjectPath(p, this.props.cwd);
            if (!result.ok) { this.notice(result.error); return; }
            this.ctx.switchProject(result.path);
          },
          () => { this.overlay.close(); this.recompute(); }
        );
        this.recompute();
      },
      currentCwd: () => this.props.cwd
    };
  }

  private sendUserMessage(text: string): void {
    if (!this.firstMessage) {
      this.firstMessage = text;
      if (this.session?.sessionId) this.recordSession(this.session.sessionId, this.providerName);
    }
    this.buffer.append({ kind: "user", text });
    this.phase = "streaming";
    this.workStartedAt = Date.now();
    this.session?.send(text);
    this.recompute();
  }

  private handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = this.registry.get(slash.name);
      if (!cmd) { this.notice(`Unknown command: /${slash.name}`); this.recompute(); return; }
      cmd.run(this.ctx, slash.args).catch(err => {
        this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        this.recompute();
      });
      return;
    }
    this.sendUserMessage(text);
  }

  /** Test helper: submits text as if typed and Enter pressed, bypassing key decoding. */
  submitForTest(text: string): void {
    this.handleSubmit(text);
  }

  tick(): void {
    this.workIndFrame += 1;
    this.recompute();
  }

  recompute(): void {
    const size = this.terminal.size();
    const inputVisible = this.overlay.mode === "none" && this.phase !== "permission";
    const bottom: BottomState = {
      overlay: this.overlay.mode,
      streaming: this.phase === "streaming",
      streamingText: this.streamText,
      activeTool: this.activeTool,
      compactPct: this.compactPct,
      scrollOffset: this.scrollOffset,
      inputRender: inputVisible
        ? this.inputBox.render(this.theme, size.columns, this.phase === "streaming")
        : { borderRows: [], contentRows: [], menuRows: [], hintRow: null, totalRows: 0 },
      overlayRows: this.overlay.isOpen ? this.overlay.render(this.theme, size.columns) : [],
      statusBarProps: {
        provider: this.providerName,
        model: this.model,
        servedModel: this.servedModel,
        mode: this.mode,
        cwd: this.props.cwd,
        costUsd: this.cost,
        gitBranch: this.git.status.branch,
        gitDirty: this.git.status.dirty,
        tokens: this.tokens,
        contextPct: this.contextPct,
        elapsedMs: Date.now() - this.startedAt
      },
      workIndFrame: this.workIndFrame,
      workStartedAt: this.workStartedAt
    };
    const frame = render(this.buffer, this.scrollOffset, bottom, this.theme, size);
    this.terminal.write(frame);
  }

  async run(): Promise<void> {
    this.running = true;
    this.session = this.createSession(this.props.initialProvider, this.props.resume);
    this.git.start();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.terminal.onResize(() => this.recompute());
    this.terminal.onLine(line => this.handleSubmit(line));
    this.recompute();
    await new Promise<void>(resolve => { this.stopResolve = resolve; });
  }

  private stopResolve: (() => void) | undefined;

  private stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.git.stop();
    this.running = false;
    this.stopResolve?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/nativeApp.ts tests/app.test.ts
git commit -m "feat(ui): add App orchestrator skeleton with message handling and command context"
```

---

### Task 17: `nativeApp.ts` — key routing and scrollback navigation

**Files:**
- Modify: `src/ui/nativeApp.ts`
- Modify: `tests/app.test.ts` (append)

**Interfaces:**
- Consumes: `Key` from `./input.js` (Task 8).
- Produces: `handleKey(k: Key)`, `handleKeys(ks: Key[])` on `App` — wired to `terminal.onKeys` in `run()`; used by Task 19 (`cli.ts` — indirectly, since `Terminal.onKeys` delivers decoded keys).

Implements the spec's three-phase key routing: **Phase 1 globals** (Ctrl-C double-tap, Ctrl-L clear+repaint, Esc-while-streaming interrupt), **Phase 2 scrollback nav** (PgUp/Ctrl-B, PgDn/Ctrl-F, Home, End — only when no overlay is open), **Phase 3 focus owner** (overlay consumes the key if open, else BackTab cycles permission mode and the key goes to `inputBox`). Also implements the Scrolling section: `scrollOffset` sentinel `null` = stick-to-bottom; any scrollback key sets a concrete number; `End` resets to `null`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/app.test.ts
import type { Key } from "../src/ui/input.js";

describe("App key routing", () => {
  it("Ctrl-C once shows a warning notice, twice within 2s exits", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "ctrl", ch: "c" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("Press Ctrl+C again to exit");
    app.handleKey({ t: "ctrl", ch: "c" });
    await wait(5);
    expect(app.isRunningForTest()).toBe(false);
  });

  it("PgUp sets a concrete scrollOffset and the StatusBar shows the scroll hint", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    for (let i = 0; i < 40; i++) app.submitForTest(`m${i}`);
    await wait(50);
    app.handleKey({ t: "pgup" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("Press End to jump to latest");
  });

  it("End resets scrollOffset to stick-to-bottom and clears the hint", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "pgup" });
    app.handleKey({ t: "end" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).not.toContain("Press End to jump to latest");
  });

  it("scrollback keys are ignored while an overlay is open", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.openResumePickerForTest();
    app.handleKey({ t: "pgup" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).not.toContain("Press End to jump to latest");
  });

  it("BackTab cycles the permission mode", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "backtab" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("acceptEdits");
  });

  it("printable keys reach the InputBox and appear in the next frame", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "printable", ch: "x" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("> x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL with "app.handleKey is not a function"

- [ ] **Step 3: Write minimal implementation**

```ts
// modify src/ui/nativeApp.ts

// add import at top:
import type { Key } from "./input.js";

// add fields:
  private lastCtrlCAt = 0;

// add test helpers (near submitForTest):
  isRunningForTest(): boolean {
    return this.running;
  }

  openResumePickerForTest(): void {
    this.ctx.openResumePicker();
  }

// add methods (near tick()):
  handleKeys(ks: Key[]): void {
    for (const k of ks) this.handleKey(k);
  }

  handleKey(k: Key): void {
    // Phase 1: globals.
    if (k.t === "esc" && this.phase === "streaming" && this.overlay.mode === "none") {
      void this.session?.interrupt();
      return;
    }
    if (k.t === "ctrl" && k.ch === "l") {
      this.recompute();
      return;
    }
    if (k.t === "ctrl" && k.ch === "c") {
      const now = Date.now();
      if (now - this.lastCtrlCAt < 2000) {
        this.ctx.exit();
      } else {
        this.lastCtrlCAt = now;
        void this.session?.interrupt();
        this.notice("Press Ctrl+C again to exit.");
        this.recompute();
      }
      return;
    }

    // Phase 2: scrollback navigation, only when no overlay is open.
    if (this.overlay.mode === "none") {
      const size = this.terminal.size();
      const height = Math.max(1, size.rows - 6);
      if (k.t === "pgup" || (k.t === "ctrl" && k.ch === "b")) {
        const total = this.buffer.totalRows(size.columns, this.theme);
        const current = this.scrollOffset ?? Math.max(0, total - height);
        this.scrollOffset = Math.max(0, current - height);
        this.recompute();
        return;
      }
      if (k.t === "pgdn" || (k.t === "ctrl" && k.ch === "f")) {
        const total = this.buffer.totalRows(size.columns, this.theme);
        const current = this.scrollOffset ?? Math.max(0, total - height);
        const next = current + height;
        this.scrollOffset = next >= total - height ? null : next;
        this.recompute();
        return;
      }
      if (k.t === "home") { this.scrollOffset = 0; this.recompute(); return; }
      if (k.t === "end") { this.scrollOffset = null; this.recompute(); return; }
    }

    // Phase 3: focus owner.
    if (this.overlay.isOpen) {
      const input = k.t === "printable" ? k.ch : undefined;
      this.overlay.handleKey(k, input);
      this.recompute();
      return;
    }
    if (k.t === "backtab") {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(this.mode) + 1) % MODE_CYCLE.length];
      this.ctx.setPermissionMode(next).catch(err => {
        this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        this.recompute();
      });
      return;
    }
    if (k.t === "paste") {
      this.inputBox.handlePaste(k.text, this.phase === "streaming");
      this.recompute();
      return;
    }
    this.inputBox.handleKey(k, this.phase === "streaming");
    this.recompute();
  }

// wire into run():
  async run(): Promise<void> {
    this.running = true;
    this.session = this.createSession(this.props.initialProvider, this.props.resume);
    this.git.start();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.terminal.onResize(() => this.recompute());
    this.terminal.onKeys(keys => this.handleKeys(keys));
    this.terminal.onLine(line => this.handleSubmit(line));
    this.recompute();
    await new Promise<void>(resolve => { this.stopResolve = resolve; });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/nativeApp.ts tests/app.test.ts
git commit -m "feat(ui): add key routing, scrollback navigation, and permission-mode cycling to App"
```

---

### Task 18: Delete obsolete Ink UI tests, verify coverage parity

**Files:**
- Delete: `tests/app.test.tsx`, `tests/bottom-fill.test.ts`, `tests/messageList.test.tsx`, `tests/statusBar.test.tsx`, `tests/suggestionMenu.test.tsx`, `tests/resumePicker.test.tsx`, `tests/projectPicker.test.tsx`, `tests/permissionDialog.test.tsx`, `tests/workingIndicator.test.tsx`
- Keep unchanged: `tests/markdown.test.ts`, `tests/transcript.test.ts`, `tests/theme.test.ts`, `tests/welcome.test.ts`, `tests/streamTail.test.ts`
- Verify: all 44 non-UI test files still pass untouched.

Per the spec's Coverage Parity table (design spec lines 239–256), every deleted file's *intent* has already landed in an earlier task: `app.test.tsx` → `tests/app.test.ts` (Tasks 16–17), `bottom-fill.test.ts` → `tests/layout.test.ts` + `tests/buffer.test.ts` (Tasks 2–3), `messageList.test.tsx` → `tests/buffer.test.ts` + `tests/render.test.ts` (Tasks 3, 15), `statusBar.test.tsx`/`suggestionMenu.test.tsx`/`workingIndicator.test.tsx` → `tests/widgets.test.ts` (Tasks 4–7), `resumePicker.test.tsx`/`projectPicker.test.tsx`/`permissionDialog.test.tsx` → `tests/overlay.test.ts` (Tasks 11–13). `inputBox.test.tsx` and `useGitStatus.test.tsx` were already deleted in Tasks 10 and 9 respectively.

- [ ] **Step 1: Delete the obsolete files**

```bash
git rm tests/app.test.tsx tests/bottom-fill.test.ts tests/messageList.test.tsx \
  tests/statusBar.test.tsx tests/suggestionMenu.test.tsx tests/resumePicker.test.tsx \
  tests/projectPicker.test.tsx tests/permissionDialog.test.tsx tests/workingIndicator.test.tsx
```

- [ ] **Step 2: Run the full suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: All remaining test files pass. `tests/skills.test.ts` shows its pre-existing unrelated `loadSkills` environment failure (per spec's Decisions ¶6, this persists untouched through the rewrite) — confirm no *other* file fails.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(ui): remove Ink-based UI tests superseded by the hand-rolled TUI test suite"
```

---

### Task 19: Wire `--tui native`, replace `src/cli.tsx` with `src/cli.ts`, dependency cleanup

**Files:**
- Create: `src/cli.ts`
- Delete: `src/cli.tsx`, `src/ui/bottomFill.ts`
- Delete tests: `tests/bottom-fill.test.ts` (already removed in Task 18 — no-op if already gone)
- Modify: `package.json`, `tsconfig.json`
- Test: `tests/cli-args.test.ts` (new — tests `parseArgs` option wiring only, since launching a real TTY app is not unit-testable)

**Interfaces:**
- Consumes: `App` from `nativeApp.ts` (Task 17), `Terminal` (Task 14), `loadProviders`/`loadSettings` (unchanged, `../agent/*`), `SessionIndex` (unchanged), `VERSION` (unchanged). The legacy Ink `App` (`src/ui/App.tsx`) and its `render(<App/>)` call stay reachable as the default path per the spec's incremental rollout — this task only *adds* the `--tui native` opt-in, it does not remove the Ink code path (that is Rollout step 5, out of scope for this plan).

Because the legacy Ink UI (`src/ui/App.tsx`, `InputBox.tsx`, `StatusBar.tsx`, etc.) must keep building and its own tests (already deleted in Task 18 alongside their hand-rolled replacements) must stay green through step 3 of the rollout, and because `src/cli.tsx` is the *only* file that imports both the Ink `App` and the new one, `src/cli.tsx` becomes `src/cli.ts` with JSX removed from the entrypoint only — the legacy `src/ui/App.tsx` keeps its own `.tsx` extension and Ink imports untouched. `tsconfig.json`'s `"jsx": "react-jsx"` must therefore stay in place (it is a global compiler flag, and `App.tsx` still needs it) — despite the spec's Dependencies & Config Changes section saying to drop it, that drop only becomes safe once the Ink UI is deleted entirely (Rollout step 5). This plan defers that line to the follow-up "delete legacy UI" work and calls it out here so it isn't silently forgotten.

`bottomFill.ts` has no remaining importers after Task 16 stopped using it (the hand-rolled `App`/`render` compute layout synchronously without a filler/measureElement dance) — but the legacy `src/ui/App.tsx` still imports it (`App.tsx:34`), so **do not delete it yet**; it is deleted only when the legacy UI is deleted in the follow-up work. Remove it from this task's file list — no action needed here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli-args.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "node:util";

// Mirrors the exact options object added to src/cli.ts's parseArgs call;
// kept as a standalone parseArgs call here since src/cli.ts runs top-level
// side effects (provider loading, process.exit on bad args) that make it
// unsafe to import directly in a test.
function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      continue: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      provider: { type: "string" },
      version: { type: "boolean", default: false },
      tui: { type: "string", default: "legacy" }
    }
  });
}

describe("cli --tui flag", () => {
  it("defaults to legacy when --tui is not passed", () => {
    expect(parseCliArgs([]).values.tui).toBe("legacy");
  });

  it("accepts --tui native", () => {
    expect(parseCliArgs(["--tui", "native"]).values.tui).toBe("native");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-args.test.ts`
Expected: This test is self-contained (calls `node:util`'s `parseArgs` directly) so it passes immediately — it exists to pin the exact options shape `src/cli.ts` must implement in Step 3. Run it now to confirm it passes against the *mirrored* shape before wiring the real file: `npx vitest run tests/cli-args.test.ts` → PASS (2 tests). This documents intent; Step 3 makes `src/cli.ts` match it.

- [ ] **Step 3: Write `src/cli.ts`**

```ts
// src/cli.ts
import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { App as LegacyApp } from "./ui/App.js";
import { App } from "./ui/nativeApp.js";
import { Terminal } from "./ui/term/terminal.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string" },
    version: { type: "boolean", default: false },
    tui: { type: "string", default: "legacy" }
  }
});

if (values.version) {
  console.log(`cloudcode ${VERSION}`);
  process.exit(0);
}

const providers = loadProviders();
const settings = loadSettings();
let providerName = values.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (values.provider) {
    console.error(`Unknown provider "${values.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(1);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}

const sessionIndex = new SessionIndex();
const initialCwd = process.cwd();
let resume: string | undefined;
if (values.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

if (values.tui === "native") {
  const terminal = new Terminal();
  const app = new App({
    cwd: initialCwd,
    providers,
    initialProvider: providerName,
    initialModel: settings.model,
    initialMode: settings.permissionMode,
    resume,
    sessionIndex,
    openResumeOnStart: values.resume
  }, terminal);
  const cleanupAndExit = (code: number) => { terminal.cleanup(); process.exit(code); };
  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("SIGTERM", () => cleanupAndExit(0));
  process.on("SIGHUP", () => cleanupAndExit(0));
  process.on("uncaughtException", err => {
    terminal.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
    terminal.cleanup();
    throw err;
  });
  app.run().finally(() => terminal.cleanup());
} else {
  function Root() {
    const [cwd, setCwd] = React.useState(initialCwd);
    const [prevCwd, setPrevCwd] = React.useState<string | undefined>(undefined);
    const switchProject = (path: string): string | undefined => {
      try {
        process.chdir(path);
      } catch (err) {
        return `Failed to switch project: ${err instanceof Error ? err.message : String(err)}`;
      }
      setPrevCwd(cwd);
      setCwd(path);
      return undefined;
    };
    return (
      <LegacyApp
        key={cwd}
        cwd={cwd}
        providers={providers}
        initialProvider={providerName}
        initialModel={settings.model}
        initialMode={settings.permissionMode}
        resume={prevCwd === undefined ? resume : undefined}
        sessionIndex={sessionIndex}
        openResumeOnStart={prevCwd === undefined ? values.resume : false}
        onSwitchProject={switchProject}
        switchedFrom={prevCwd}
      />
    );
  }
  render(<Root />);
}
```

Note: `src/cli.ts` contains JSX in its `else` branch (the legacy path), so it cannot literally have a `.ts` extension under `tsconfig.json`'s current settings without `.tsx`. Rename the created file to `src/cli.tsx` instead of `src/cli.ts` for this task — the spec's "`src/cli.tsx` becomes `src/cli.ts` (no JSX)" instruction only applies once the legacy branch is deleted (Rollout step 5, out of scope here). Delete `src/cli.tsx`'s *old* content and replace it with the above; do not create a second file.

- [ ] **Step 4: Update `package.json` scripts (no dependency removal yet — legacy UI still needs Ink/React)**

Confirm `package.json`'s `"dev"` script still reads `"tsx src/cli.tsx"` (unchanged — the file keeps its `.tsx` extension per Step 3's note). No edit needed if it already reads that; verify with:

```bash
grep -n '"dev"' package.json
```

Expected: `"dev": "tsx src/cli.tsx",` — already correct, no change required this task.

- [ ] **Step 5: Run the full build and test suite**

Run: `npm run build && npm test`
Expected: `tsc -p tsconfig.json` succeeds (both the legacy Ink UI and the new hand-rolled UI type-check under the unchanged `"jsx": "react-jsx"` setting). `vitest run` is green except the pre-existing unrelated `tests/skills.test.ts` failure.

- [ ] **Step 6: Manually smoke-test the new UI is reachable**

Run: `npx tsx src/cli.tsx --tui native --version`
Expected: prints `cloudcode <version>` and exits 0 (the `--version` short-circuit runs before the `--tui` branch, confirming argument parsing doesn't crash with the new flag present).

- [ ] **Step 7: Commit**

```bash
git add src/cli.tsx tests/cli-args.test.ts
git commit -m "feat(cli): add --tui native opt-in flag alongside the existing Ink UI"
```

---

## Follow-up work (explicitly out of scope for this plan)

Per the spec's Rollout steps 4–5 and the Global Constraints section above:

- **Real-terminal dogfooding** of `--tui native` across Windows Terminal, conhost, iTerm2, and SSH sessions, fixing any issues found against the test suite added in Tasks 1–17.
- **Flipping the default**: `--tui native` becomes default, the Ink UI becomes `--tui legacy` for one release, then in the following release: delete `src/ui/App.tsx`, `MessageList.tsx`, `InputBox.tsx` (Ink version), `StatusBar.tsx` (Ink version), `PermissionDialog.tsx`, `ResumePicker.tsx`, `ProjectPicker.tsx`, `SuggestionMenu.tsx`, `WorkingIndicator.tsx`, `ProgressBar.tsx`, `ThemeContext.tsx`, `bottomFill.ts`; rename `src/ui/nativeApp.ts` to `src/ui/App.ts` (now safe — the name collision with the deleted `App.tsx` is gone) and update its one importer in `src/cli.ts`; remove `ink`, `ink-spinner`, `react`, `@types/react`, `@types/marked-terminal`, `react-devtools-core`, `ink-testing-library` from `package.json`; drop `"jsx": "react-jsx"` from `tsconfig.json`; rename `src/cli.tsx` → `src/cli.ts` with the legacy branch removed.
