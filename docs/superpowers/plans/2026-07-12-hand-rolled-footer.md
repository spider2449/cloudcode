# Hand-Rolled Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manually scrolling the terminal viewport moves only the transcript; the input box and status bar stay fixed to the terminal's bottom rows, matching Claude Code — implemented as a hand-rolled, non-Ink footer to avoid the bug classes the abandoned dual-Ink-instance approach hit.

**Architecture:** A single Ink instance renders `App` (transcript + overlays) into a `.rows`-shrinking `stdout` proxy. The footer (input box, suggestion menu, status bar) is a plain-TypeScript module with no React/Ink involvement: it owns `process.stdin` directly, maintains its own state (ported from `InputBox.tsx`'s existing ref-based logic), and writes its own output via absolute cursor positioning wrapped in save/restore, inside a DECSTBM scroll margin.

**Tech Stack:** Ink 5 (single instance, for `App` only), `ansi-escapes` (cursor positioning), `ansi-styles` (theme colors — already a transitive dependency, confirmed present at `node_modules/ansi-styles`, no new package needed), Ink's own `parse-keypress.js` (deep-imported — see Task 1's rationale), React 18, vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-hand-rolled-footer-design.md`

## Global Constraints

- All code, comments, and names in English only.
- Full feature parity with the current `InputBox`/`StatusBar`/`SuggestionMenu`: history recall, suggestion menu (commands + files), backtick line-continuation, cursor movement, Escape-suppresses-menu, Tab/Enter accept-or-submit — no functional regression, only the rendering/input mechanism changes.
- No fallback path for terminals without DECSTBM support (target: VS Code integrated terminal, Windows Terminal, xterm-compatible) — a cosmetic no-op margin is acceptable on unsupported terminals, a crash is not.
- The scroll margin must be reset (`\x1b[r`) on process exit and `SIGINT`.
- The footer's own writer must protect content's Ink instance's cursor across every footer write (save → position → write → restore) — content is a normal, unmodified Ink instance doing its own relative repaint math and must never observe a cursor displacement it didn't cause itself.
- Reuse pure logic verbatim where it already exists and has no Ink/React dependency: `commands/completion.ts`, `agent/history.ts`, `src/ui/bottomFill.ts`'s wrap-math helpers, `src/ui/StatusBar.tsx`'s `formatTokens`/`formatElapsed`, `src/ui/theme.ts`'s `Theme`/`THEMES`, `src/ui/SuggestionMenu.tsx`'s `visibleWindow`/`MAX_ROWS`.

---

### Task 1: Footer key parsing + state machine (pure, no I/O)

**Files:**
- Create: `src/ui/footerKeys.ts`
- Create: `src/ui/footerState.ts`
- Test: `tests/footerKeys.test.ts`
- Test: `tests/footerState.test.ts`

**Interfaces:**
- Produces (Task 4 relies on these exact signatures):
  ```ts
  // footerKeys.ts
  export interface ParsedKey {
    upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean;
    return: boolean; escape: boolean; ctrl: boolean; shift: boolean; tab: boolean;
    backspace: boolean; delete: boolean; meta: boolean;
  }
  export function parseStdinChunk(chunk: Buffer | string): { input: string; key: ParsedKey };

  // footerState.ts
  export interface FooterStateOptions {
    completionCtx: CompletionContext; // from commands/completion.js
    history: History; // from agent/history.js
    onSubmit(text: string): void;
    columns: number;
    disabled: boolean;
  }
  export interface FooterSnapshot {
    value: string; cursor: number; selected: number;
    suggestions: Suggestion[]; // from commands/completion.js
    inputRows: number; // exact rendered row count of the bordered input box
  }
  export class FooterState {
    constructor(options: FooterStateOptions);
    snapshot(): FooterSnapshot;
    setColumns(columns: number): void;
    setDisabled(disabled: boolean): void;
    handleKey(input: string, key: ParsedKey): void; // mutates state; caller re-reads snapshot()
  }
  ```

**Context:** `InputBox.tsx` (`src/ui/InputBox.tsx` as it exists on `master`) already implements nearly all of this logic imperatively via `useRef`-backed state (`valueRef`, `cursorRef`, `draftRef`, `suppressedRef`, `selectedRef`, `hadAtTokenRef`) — the `useState` calls there exist only to trigger JSX re-renders, which no longer apply here. Port the `update`, `submit`, `accept`, `acceptIsNoop`, `currentSuggestions`, `currentInputRows`, and the full `useInput` callback body (`src/ui/InputBox.tsx` lines 172–243) into `FooterState` methods almost unchanged — the callback body becomes `handleKey`'s body, receiving the same `(input, key)` shape it already expects. Reuse `inputBoxRows` from `src/ui/bottomFill.ts` for `currentInputRows`'s equivalent, exactly as `InputBox.tsx` already does.

Ink's own key parsing (`node_modules/ink/build/parse-keypress.js`, itself copied from `enquirer`) correctly handles arrow keys, ctrl+letter combos, meta sequences, and paste-chunk edge cases that would be high-risk to reimplement from scratch. Deep-import it directly (`ink/build/parse-keypress.js`) rather than reimplementing — this is a deliberate, justified exception to not depending on Ink internals elsewhere in this plan, because the alternative (reimplementing terminal key-sequence parsing) is exactly the kind of high-risk, easy-to-get-subtly-wrong logic this plan's "full feature parity" constraint warns against. `parseStdinChunk` then mirrors the conversion from Ink's own `use-input.js` (`node_modules/ink/build/hooks/use-input.js`, the `handleData` function body) that turns `parseKeypress`'s raw output into the `{upArrow, downArrow, ..., ctrl, shift, tab, backspace, delete, meta}` shape `InputBox.tsx`'s handler already consumes — copy that conversion logic verbatim (it is small, self-contained, and already proven correct in production).

- [ ] **Step 1: Write the failing tests for `footerKeys.ts`**

Create `tests/footerKeys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseStdinChunk } from "../src/ui/footerKeys.js";

describe("parseStdinChunk", () => {
  it("parses a plain printable character", () => {
    const { input, key } = parseStdinChunk("a");
    expect(input).toBe("a");
    expect(key.upArrow).toBe(false);
  });

  it("parses the up arrow escape sequence", () => {
    const { key } = parseStdinChunk("\x1b[A");
    expect(key.upArrow).toBe(true);
  });

  it("parses the down arrow escape sequence", () => {
    const { key } = parseStdinChunk("\x1b[B");
    expect(key.downArrow).toBe(true);
  });

  it("parses left/right arrows", () => {
    expect(parseStdinChunk("\x1b[D").key.leftArrow).toBe(true);
    expect(parseStdinChunk("\x1b[C").key.rightArrow).toBe(true);
  });

  it("parses backspace (\\x7f) as delete per Ink's own convention, and \\b as backspace", () => {
    // Matches node_modules/ink/build/parse-keypress.js's own mapping exactly
    // (see that file's \\x7f vs \\b branches) — do not "fix" this asymmetry,
    // it is intentional upstream behavior InputBox.tsx already relies on
    // (its handler checks `key.backspace || key.delete` together).
    expect(parseStdinChunk("\x7f").key.delete).toBe(true);
    expect(parseStdinChunk("\b").key.backspace).toBe(true);
  });

  it("parses Ctrl+C", () => {
    const { input, key } = parseStdinChunk("\x03");
    expect(key.ctrl).toBe(true);
    expect(input).toBe("c");
  });

  it("parses Escape", () => {
    expect(parseStdinChunk("\x1b").key.escape).toBe(true);
  });

  it("parses Tab", () => {
    expect(parseStdinChunk("\t").key.tab).toBe(true);
  });

  it("parses Return", () => {
    expect(parseStdinChunk("\r").key.return).toBe(true);
  });

  it("parses Shift+Tab as the tab key with shift set", () => {
    // Matches keyName['[Z'] === 'tab' plus isShiftKey(['[Z']) in
    // parse-keypress.js — this is how InputBox.tsx's onShiftTab detection
    // (key.tab && key.shift) already works.
    const { key } = parseStdinChunk("\x1b[Z");
    expect(key.tab).toBe(true);
    expect(key.shift).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/footerKeys.test.ts`
Expected: FAIL — cannot resolve `../src/ui/footerKeys.js`.

- [ ] **Step 3: Write `src/ui/footerKeys.ts`**

```ts
// Ink's own key-sequence parser (node_modules/ink/build/parse-keypress.js,
// itself copied from enquirer) correctly handles arrow keys, ctrl+letter
// combos, meta sequences, and paste-chunk edge cases that would be high-risk
// to reimplement from scratch. Deep-importing it is a deliberate exception
// to this codebase's general preference for not depending on Ink internals:
// the alternative is reimplementing terminal key-sequence parsing, which is
// exactly the class of subtle, easy-to-get-wrong logic worth avoiding.
import parseKeypress, { nonAlphanumericKeys } from "ink/build/parse-keypress.js";

export interface ParsedKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

// Mirrors node_modules/ink/build/hooks/use-input.js's handleData function
// body verbatim (the conversion from parseKeypress's raw {name, ctrl, ...}
// shape into the {upArrow, downArrow, ...} shape Ink's useInput callbacks
// receive) so InputBox.tsx's existing handler logic — ported into
// footerState.ts's handleKey — needs no changes to consume it.
export function parseStdinChunk(chunk: Buffer | string): { input: string; key: ParsedKey } {
  const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keypress = parseKeypress(data);
  const key: ParsedKey = {
    upArrow: keypress.name === "up",
    downArrow: keypress.name === "down",
    leftArrow: keypress.name === "left",
    rightArrow: keypress.name === "right",
    return: keypress.name === "return",
    escape: keypress.name === "escape",
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === "tab",
    backspace: keypress.name === "backspace",
    delete: keypress.name === "delete",
    meta: keypress.meta || keypress.name === "escape" || keypress.option
  };
  let input = keypress.ctrl ? keypress.name : keypress.sequence;
  if (nonAlphanumericKeys.includes(keypress.name)) input = "";
  if (input.startsWith("")) input = input.slice(1);
  if (input.length === 1 && typeof input[0] === "string" && /[A-Z]/.test(input[0])) key.shift = true;
  return { input, key };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/footerKeys.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Read `src/ui/InputBox.tsx` and `src/ui/bottomFill.ts` fully**, then write the failing tests for `footerState.ts`

Create `tests/footerState.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FooterState } from "../src/ui/footerState.js";
import { History } from "../src/agent/history.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionContext } from "../src/commands/completion.js";

function makeCompletionCtx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: new Map(),
    providerNames: () => [],
    availableModels: () => [],
    listFiles: () => [],
    ...overrides
  };
}

function makeHistory(): History {
  return new History(join(mkdtempSync(join(tmpdir(), "footer-state-")), "history.json"));
}

describe("FooterState", () => {
  it("starts empty", () => {
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit: vi.fn(), columns: 80, disabled: false
    });
    const snap = state.snapshot();
    expect(snap.value).toBe("");
    expect(snap.cursor).toBe(0);
    expect(snap.inputRows).toBe(3); // border(2) + 1 content row, matching InputBox.tsx's baseline.
  });

  it("appends a typed printable character", () => {
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit: vi.fn(), columns: 80, disabled: false
    });
    state.handleKey("h", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false });
    expect(state.snapshot().value).toBe("h");
    expect(state.snapshot().cursor).toBe(1);
  });

  it("backspace removes the character before the cursor", () => {
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit: vi.fn(), columns: 80, disabled: false
    });
    const noKey = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false };
    state.handleKey("h", noKey);
    state.handleKey("i", noKey);
    state.handleKey("", { ...noKey, backspace: true });
    expect(state.snapshot().value).toBe("h");
  });

  it("submits on Enter and calls onSubmit with the trimmed text", () => {
    const onSubmit = vi.fn();
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit, columns: 80, disabled: false
    });
    const noKey = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false };
    for (const ch of "hi") state.handleKey(ch, noKey);
    state.handleKey("", { ...noKey, return: true });
    expect(onSubmit).toHaveBeenCalledWith("hi");
    expect(state.snapshot().value).toBe("");
  });

  it("backtick line-continuation swaps a trailing backslash for a newline instead of submitting", () => {
    const onSubmit = vi.fn();
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit, columns: 80, disabled: false
    });
    const noKey = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false };
    for (const ch of "a\\") state.handleKey(ch, noKey);
    state.handleKey("", { ...noKey, return: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(state.snapshot().value).toBe("a\n");
  });

  it("up arrow recalls history when the menu is closed", () => {
    const history = makeHistory();
    history.add("previous command");
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history, onSubmit: vi.fn(), columns: 80, disabled: false
    });
    state.handleKey("", { upArrow: true, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false });
    expect(state.snapshot().value).toBe("previous command");
  });

  it("inputRows grows when the wrapped content needs more than one line", () => {
    const state = new FooterState({
      completionCtx: makeCompletionCtx(), history: makeHistory(),
      onSubmit: vi.fn(), columns: 10, disabled: false
    });
    const noKey = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false };
    for (const ch of "a very long line that will wrap") state.handleKey(ch, noKey);
    expect(state.snapshot().inputRows).toBeGreaterThan(3);
  });

  it("reports suggestions from the completion context when a matching prefix is typed", () => {
    const registry = new Map([["help", { name: "help", description: "show help", run: vi.fn() }]]);
    const state = new FooterState({
      completionCtx: makeCompletionCtx({ registry: registry as never }), history: makeHistory(),
      onSubmit: vi.fn(), columns: 80, disabled: false
    });
    const noKey = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false };
    for (const ch of "/he") state.handleKey(ch, noKey);
    expect(state.snapshot().suggestions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/footerState.test.ts`
Expected: FAIL — cannot resolve `../src/ui/footerState.js`.

- [ ] **Step 7: Write `src/ui/footerState.ts`**, porting `InputBox.tsx`'s logic (`update`, `submit`, `accept`, `acceptIsNoop`, `currentSuggestions`, `currentInputRows`, and the full `useInput` handler body) into class methods. Use the exact same control flow as the source — this is a mechanical port, not a redesign:

```ts
import { getSuggestions, applySuggestion, type CompletionContext, type Suggestion } from "../commands/completion.js";
import type { History } from "../agent/history.js";
import { inputBoxRows } from "./bottomFill.js";
import type { ParsedKey } from "./footerKeys.js";

export interface FooterStateOptions {
  completionCtx: CompletionContext;
  history: History;
  onSubmit(text: string): void;
  columns: number;
  disabled: boolean;
}

export interface FooterSnapshot {
  value: string;
  cursor: number;
  selected: number;
  suggestions: Suggestion[];
  inputRows: number;
}

export class FooterState {
  private value = "";
  private cursor = 0;
  private selected = 0;
  private suggestions: Suggestion[] = [];
  private draft: string | undefined = undefined;
  private suppressed = false;
  private hadAtToken = false;
  private columns: number;
  private disabled: boolean;

  constructor(private options: FooterStateOptions) {
    this.columns = options.columns;
    this.disabled = options.disabled;
    this.sync();
  }

  setColumns(columns: number): void {
    this.columns = columns;
    this.sync();
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.sync();
  }

  snapshot(): FooterSnapshot {
    return {
      value: this.value,
      cursor: this.cursor,
      selected: this.selected,
      suggestions: this.suggestions,
      inputRows: this.currentInputRows()
    };
  }

  private currentSuggestions(): Suggestion[] {
    if (this.suppressed) return [];
    return getSuggestions(this.value, this.cursor, this.options.completionCtx);
  }

  private currentInputRows(): number {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const content = "> " + before + (this.disabled ? "" : "█") + after;
    return inputBoxRows(content, this.columns);
  }

  private sync(): void {
    this.suggestions = this.currentSuggestions();
  }

  private update(nextValue: string, nextCursor: number): void {
    const changed = nextValue !== this.value;
    this.value = nextValue;
    this.cursor = Math.max(0, Math.min(nextCursor, nextValue.length));
    if (changed) {
      this.suppressed = false;
      this.selected = 0;
      const hasAt = /(^|\s)@[\w./-]*$/.test(nextValue.slice(0, this.cursor));
      if (hasAt && !this.hadAtToken) this.options.completionCtx.refreshFiles?.();
      this.hadAtToken = hasAt;
    }
    this.sync();
  }

  private submit(): void {
    const current = this.value;
    if (current.endsWith("\\")) {
      this.update(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    this.update("", 0);
    this.draft = undefined;
    this.options.history.resetCursor();
    if (text) {
      this.options.history.add(text);
      this.options.onSubmit(text);
    }
  }

  private accept(suggestions: Suggestion[]): void {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    const r = applySuggestion(this.value, s);
    this.update(r.text, r.cursor);
  }

  private acceptIsNoop(suggestions: Suggestion[]): boolean {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    return applySuggestion(this.value, s).text === this.value.trimEnd();
  }

  handleKey(input: string, key: ParsedKey): void {
    if (this.disabled) return;
    if (key.ctrl || key.meta) return;
    const menu = this.currentSuggestions();
    const menuOpen = menu.length > 0;
    if (key.escape && menuOpen) {
      this.suppressed = true;
      this.sync();
      return;
    }
    if (key.leftArrow) { this.update(this.value, this.cursor - 1); return; }
    if (key.rightArrow) { this.update(this.value, this.cursor + 1); return; }
    if (key.upArrow) {
      if (menuOpen) {
        this.selected = (this.selected - 1 + menu.length) % menu.length;
        return;
      }
      if (this.draft === undefined) this.draft = this.value;
      const recalled = this.options.history.back();
      if (recalled !== undefined) this.update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
      if (menuOpen) {
        this.selected = (this.selected + 1) % menu.length;
        return;
      }
      const recalled = this.options.history.forward();
      if (recalled !== undefined) {
        this.update(recalled, recalled.length);
      } else {
        this.update(this.draft ?? "", (this.draft ?? "").length);
        this.draft = undefined;
      }
      return;
    }
    if (key.backspace || key.delete) {
      const v = this.value;
      const c = this.cursor;
      if (c > 0) this.update(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }
    if (key.tab) {
      if (menuOpen) this.accept(menu);
      return;
    }
    if (key.return && !input) {
      if (menuOpen && !this.acceptIsNoop(menu)) this.accept(menu);
      else this.submit();
      return;
    }
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        const m = this.currentSuggestions();
        if (m.length > 0 && !this.acceptIsNoop(m)) this.accept(m);
        else this.submit();
      } else if (ch >= " ") {
        const v = this.value;
        const c = this.cursor;
        this.update(v.slice(0, c) + ch + v.slice(c), c + 1);
      }
    }
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/footerState.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 9: Run both test files together and typecheck**

Run: `npx vitest run tests/footerKeys.test.ts tests/footerState.test.ts`
Expected: PASS (18 tests total).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/ui/footerKeys.ts src/ui/footerState.ts tests/footerKeys.test.ts tests/footerState.test.ts
git commit -m "feat(ui): hand-rolled footer key parsing and input state machine"
```

---

### Task 2: Footer rendering (pure string-building)

**Files:**
- Create: `src/ui/footerRender.ts`
- Test: `tests/footerRender.test.ts`

**Interfaces:**
- Consumes from Task 1: `FooterSnapshot` (shape only, no runtime dependency).
- Consumes: `Theme` from `src/ui/theme.ts`, `visibleWindow`/`MAX_ROWS` from `src/ui/SuggestionMenu.tsx`, `formatTokens`/`formatElapsed` from `src/ui/StatusBar.tsx`.
- Produces (Task 4 relies on these exact signatures):
  ```ts
  export interface StatusBarData {
    provider: string; model?: string; servedModel?: string; mode: string; cwd: string;
    costUsd?: number; gitBranch?: string; gitDirty?: boolean;
    tokens?: number; contextPct?: number; elapsedMs?: number;
  }
  export function renderInputBoxLines(snapshot: FooterSnapshot, columns: number, disabled: boolean, theme: Theme): string[];
  export function renderSuggestionMenuLines(snapshot: FooterSnapshot, columns: number, theme: Theme): string[];
  export function renderStatusBarLine(data: StatusBarData, theme: Theme): string;
  export function renderFooterLines(snapshot: FooterSnapshot, columns: number, disabled: boolean, statusData: StatusBarData, theme: Theme): string[];
  ```

**Context:** Read `src/ui/InputBox.tsx`'s JSX return (the bordered `Box` + `Text`), `src/ui/SuggestionMenu.tsx`'s JSX, and `src/ui/StatusBar.tsx`'s JSX fully before starting — this task reproduces their exact visual output as plain strings using `ansi-styles` instead of Ink `<Text color>`/`<Box borderStyle>`. `ansi-styles` (confirmed present at `node_modules/ansi-styles`) exposes named colors directly on its default export, e.g. `ansiStyles.blue.open` / `ansiStyles.blue.close` (verified against `node_modules/ansi-styles/index.js`), matching every color name used in `src/ui/theme.ts`'s `Theme` interface (`"blue"`, `"cyan"`, `"gray"`, `"red"`, `"green"`, `"magenta"`, `"yellow"`, `"blackBright"` etc.).

Ink's `borderStyle="round"` box (used by `InputBox.tsx`) draws a rounded-corner box using specific Unicode box-drawing characters, sourced from the `cli-boxes` package — the exact character set is confirmed in Step 1 below, so this task's code uses the real values directly, not placeholders.

- [ ] **Step 1: Ink's exact `round` border character set (already verified)**

Ink sources its border presets from the `cli-boxes` package
(`node_modules/cli-boxes/boxes.json`). The `round` preset, confirmed by
reading that file directly, is:
`{ topLeft: "╭", top: "─", topRight: "╮", right: "│", bottomRight: "╯", bottom: "─", bottomLeft: "╰", left: "│" }`
— these are the exact values used in Step 3's code below (`BORDER_TOP_LEFT`
etc.); no further lookup needed for this step.

- [ ] **Step 2: Write the failing tests**

Create `tests/footerRender.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderInputBoxLines, renderSuggestionMenuLines, renderStatusBarLine, renderFooterLines } from "../src/ui/footerRender.js";
import { THEMES } from "../src/ui/theme.js";
import type { FooterSnapshot } from "../src/ui/footerState.js";

const emptySnapshot: FooterSnapshot = { value: "", cursor: 0, selected: 0, suggestions: [], inputRows: 3 };

describe("renderInputBoxLines", () => {
  it("renders exactly 3 lines for an empty single-line input (top border, content, bottom border)", () => {
    const lines = renderInputBoxLines(emptySnapshot, 80, false, THEMES.dark);
    expect(lines.length).toBe(3);
  });

  it("includes the '> ' prompt and cursor block in the content line", () => {
    const lines = renderInputBoxLines(emptySnapshot, 80, false, THEMES.dark);
    const stripped = lines[1].replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("> ");
  });

  it("shows the disabled hint instead of the cursor block when disabled", () => {
    const lines = renderInputBoxLines(emptySnapshot, 80, true, THEMES.dark);
    const joined = lines.join("").replace(/\x1b\[[0-9;]*m/g, "");
    expect(joined).not.toContain("█");
  });
});

describe("renderSuggestionMenuLines", () => {
  it("returns one line per suggestion, capped at MAX_ROWS", () => {
    const snap: FooterSnapshot = {
      ...emptySnapshot,
      suggestions: Array.from({ length: 12 }, (_, i) => ({ value: `/cmd${i} `, label: `/cmd${i}`, replaceStart: 0, replaceEnd: 0 }))
    };
    const lines = renderSuggestionMenuLines(snap, 80, THEMES.dark);
    expect(lines.length).toBe(8); // SuggestionMenu.MAX_ROWS
  });

  it("marks the selected suggestion with the selection marker", () => {
    const snap: FooterSnapshot = {
      ...emptySnapshot,
      selected: 0,
      suggestions: [{ value: "/help ", label: "/help", replaceStart: 0, replaceEnd: 0 }]
    };
    const lines = renderSuggestionMenuLines(snap, 80, THEMES.dark);
    const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped.startsWith("▶ ")).toBe(true); // matches SuggestionMenu.tsx's "▶ " marker.
  });
});

describe("renderStatusBarLine", () => {
  it("joins segments with the middot separator, matching StatusBar.tsx", () => {
    const line = renderStatusBarLine({ provider: "anthropic", mode: "default", cwd: "/p" }, THEMES.dark);
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe("anthropic · default · /p");
  });
});

describe("renderFooterLines", () => {
  it("concatenates input box lines, suggestion menu lines (if any), and the status bar line", () => {
    const lines = renderFooterLines(emptySnapshot, 80, false, { provider: "anthropic", mode: "default", cwd: "/p" }, THEMES.dark);
    expect(lines.length).toBe(4); // 3 input box lines + 1 status bar line, no menu open.
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/footerRender.test.ts`
Expected: FAIL — cannot resolve `../src/ui/footerRender.js`.

- [ ] **Step 4: Write `src/ui/footerRender.ts`**, using the exact border characters confirmed in Step 1:

```ts
import ansiStyles from "ansi-styles";
import type { Theme } from "./theme.js";
import type { FooterSnapshot } from "./footerState.js";
import { visibleWindow, MAX_ROWS } from "./SuggestionMenu.js";
import { formatTokens, formatElapsed } from "./StatusBar.js";
import { textRows } from "./bottomFill.js";

// Exact characters from cli-boxes's "round" preset (node_modules/cli-boxes/boxes.json),
// which Ink's borderStyle="round" uses — verified during planning, see Step 1.
const BORDER_TOP_LEFT = "╭";
const BORDER_TOP_RIGHT = "╮";
const BORDER_BOTTOM_LEFT = "╰";
const BORDER_BOTTOM_RIGHT = "╯";
const BORDER_HORIZONTAL = "─";
const BORDER_VERTICAL = "│";

function colorize(text: string, colorName: string | undefined): string {
  if (!colorName) return text;
  const style = (ansiStyles as unknown as Record<string, { open: string; close: string }>)[colorName];
  if (!style) return text;
  return style.open + text + style.close;
}

export function renderInputBoxLines(snapshot: FooterSnapshot, columns: number, disabled: boolean, theme: Theme): string[] {
  const before = snapshot.value.slice(0, snapshot.cursor);
  const after = snapshot.value.slice(snapshot.cursor);
  const content = "> " + before + (disabled ? "" : "█") + after;
  // Border + paddingX=1 consume 4 columns total (matching bottomFill.ts's
  // inputBoxRows convention, kept in sync with Task 1's footerState.ts).
  const innerWidth = Math.max(1, columns - 4);
  const wrapped = content.split("\n").flatMap(line => {
    const rows: string[] = [];
    for (let i = 0; i < line.length; i += innerWidth) rows.push(line.slice(i, i + innerWidth));
    return rows.length ? rows : [""];
  });
  const horizontal = BORDER_HORIZONTAL.repeat(columns - 2);
  const lines: string[] = [];
  lines.push(BORDER_TOP_LEFT + horizontal + BORDER_TOP_RIGHT);
  for (const row of wrapped) {
    lines.push(BORDER_VERTICAL + " " + row.padEnd(innerWidth) + " " + BORDER_VERTICAL);
  }
  lines.push(BORDER_BOTTOM_LEFT + horizontal + BORDER_BOTTOM_RIGHT);
  if (disabled) lines.push(colorize("working… (Esc to interrupt)", theme.muted));
  return lines;
}

export function renderSuggestionMenuLines(snapshot: FooterSnapshot, columns: number, theme: Theme): string[] {
  const { suggestions, selected } = snapshot;
  if (suggestions.length === 0) return [];
  const { start, end } = visibleWindow(suggestions.length, selected, MAX_ROWS);
  const width = Math.max(...suggestions.map(s => s.label.length));
  return suggestions.slice(start, end).map((s, i) => {
    const isSelected = start + i === selected;
    const marker = isSelected ? "▶ " : "  ";
    const label = colorize(marker + s.label.padEnd(width + 2), isSelected ? theme.accent : undefined);
    const desc = s.description ? " " + colorize(s.description, theme.muted) : "";
    return label + desc;
  });
}

export interface StatusBarData {
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
}

export function renderStatusBarLine(data: StatusBarData, theme: Theme): string {
  const segments: string[] = [];
  const modelLabel =
    data.servedModel && data.model && data.servedModel !== data.model
      ? `${data.model}→${data.servedModel}` : data.servedModel ?? data.model;
  segments.push(data.provider + (modelLabel ? `/${modelLabel}` : ""));
  segments.push(data.mode);
  if (data.gitBranch) segments.push(`⏁ ${data.gitBranch}${data.gitDirty ? "*" : ""}`);
  if (data.tokens != null && data.tokens > 0) {
    segments.push(formatTokens(data.tokens) + (data.contextPct != null ? ` (${data.contextPct}%)` : ""));
  }
  if (data.costUsd && data.costUsd > 0) segments.push(`$${data.costUsd.toFixed(4)}`);
  if (data.elapsedMs != null && data.elapsedMs > 0) segments.push(formatElapsed(data.elapsedMs));
  segments.push(data.cwd);
  return colorize(segments.join(" · "), theme.muted);
}

export function renderFooterLines(
  snapshot: FooterSnapshot, columns: number, disabled: boolean, statusData: StatusBarData, theme: Theme
): string[] {
  return [
    ...renderInputBoxLines(snapshot, columns, disabled, theme),
    ...(disabled ? [] : renderSuggestionMenuLines(snapshot, columns, theme)),
    renderStatusBarLine(statusData, theme)
  ];
}
```

Note: `renderInputBoxLines`'s wrap logic is a simplified character-count wrap; if Step 1's reading of `bottomFill.ts`/`InputBox.tsx` reveals the existing wrap convention differs (e.g. word-wrapping vs. hard character wrapping), match the existing convention exactly rather than this sketch — the goal is pixel-identical output to what ships today, not a new wrapping algorithm.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/footerRender.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Visual sanity check.** Write a tiny throwaway script (not committed) that calls `renderFooterLines` with representative data and `console.log`s the joined output with `\n` between lines, run it with `npx tsx`, and confirm by eye it looks like today's `InputBox`/`StatusBar` (rounded border, correct colors in a color-capable terminal). Delete the script after.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/ui/footerRender.ts tests/footerRender.test.ts
git commit -m "feat(ui): hand-rolled footer rendering (input box, suggestion menu, status bar)"
```

---

### Task 3: Footer writer + DECSTBM margin (terminal I/O)

**Files:**
- Create: `src/ui/footerWriter.ts`
- Test: `tests/footerWriter.test.ts`

**Interfaces:**
- Produces (Task 4 relies on these exact signatures):
  ```ts
  export interface FooterWriter {
    contentStdout: NodeJS.WriteStream; // .rows shrunk by the footer's current row count
    writeFooter(lines: string[]): void; // erases the previous frame's rows, writes `lines` at the margin origin
    teardown(): void; // resets the DECSTBM margin to full-screen
  }
  export function createFooterWriter(stdout: NodeJS.WriteStream): FooterWriter;
  ```

**Context:** This is the simplified counterpart to the abandoned design's `terminalRegions.ts` (see `docs/superpowers/specs/2026-07-12-hand-rolled-footer-design.md` for why it's simpler here): there is no wrapped `log-update` instance to interoperate with, so `writeFooter` always knows its own exact row count directly from `lines.length` — no `eraseLines`-prefix parsing, no cursor-hide/show interleaving concern, no "virtual resting row" headroom requirement. It still must protect content's Ink instance's cursor (save → position → write → restore), because content is a normal, unmodified Ink instance doing its own relative repaint math via its own `log-update`.

- [ ] **Step 1: Write the failing tests**

Create `tests/footerWriter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import ansiEscapes from "ansi-escapes";
import { createFooterWriter } from "../src/ui/footerWriter.js";

function fakeRealStdout() {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  return {
    write: (d: string) => { writes.push(d); return true; },
    get columns() { return 80; },
    rows: 24,
    on: (event: string, cb: () => void) => { (listeners[event] ??= []).push(cb); },
    off: (event: string, cb: () => void) => { listeners[event] = (listeners[event] ?? []).filter(l => l !== cb); },
    emit: (event: string) => { for (const cb of listeners[event] ?? []) cb(); },
    writes
  };
}

describe("createFooterWriter", () => {
  it("sets the initial DECSTBM margin excluding the footer's starting row count", () => {
    const real = fakeRealStdout();
    createFooterWriter(real as never);
    // Starts with 0 footer rows (nothing written yet) -> full-height margin.
    expect(real.writes).toContain(`\x1b[1;24r`);
  });

  it("writeFooter positions at the terminal's true last rows (no wasted headroom row)", () => {
    const real = fakeRealStdout();
    const { writeFooter } = createFooterWriter(real as never);
    writeFooter(["line1", "line2", "line3", "line4"]);
    // 4 lines -> origin row = 24 - 4 + 1 = 21 (1-indexed) -> 0-indexed 20.
    const last = real.writes[real.writes.length - 1];
    expect(last).toContain(ansiEscapes.cursorSavePosition);
    expect(last).toContain(ansiEscapes.cursorTo(0, 20));
    expect(last).toContain(ansiEscapes.cursorRestorePosition);
  });

  it("writeFooter re-issues the margin when the row count changes", () => {
    const real = fakeRealStdout();
    const { writeFooter } = createFooterWriter(real as never);
    writeFooter(["a", "b"]);
    expect(real.writes).toContain(`\x1b[1;22r`);
    writeFooter(["a", "b", "c"]);
    expect(real.writes).toContain(`\x1b[1;21r`);
  });

  it("writeFooter clears rows that shrink out of the new frame when going from more lines to fewer", () => {
    const real = fakeRealStdout();
    const { writeFooter } = createFooterWriter(real as never);
    writeFooter(["a", "b", "c", "d"]); // origin 21 (1-indexed), rows 21-24.
    writeFooter(["a", "b"]); // origin 23 (1-indexed), rows 23-24; rows 21-22 must be cleared.
    const last = real.writes[real.writes.length - 1];
    expect(last).toContain(ansiEscapes.cursorTo(0, 20) + "\x1b[2K"); // row 21 (0-indexed 20) cleared.
    expect(last).toContain(ansiEscapes.cursorTo(0, 21) + "\x1b[2K"); // row 22 (0-indexed 21) cleared.
  });

  it("contentStdout.rows shrinks by the footer's current row count", () => {
    const real = fakeRealStdout();
    const { contentStdout, writeFooter } = createFooterWriter(real as never);
    writeFooter(["a", "b", "c"]);
    expect(contentStdout.rows).toBe(21);
  });

  it("contentStdout.write passes through unmodified", () => {
    const real = fakeRealStdout();
    const { contentStdout } = createFooterWriter(real as never);
    contentStdout.write("hello");
    expect(real.writes).toContain("hello");
  });

  it("teardown resets the margin to full-screen", () => {
    const real = fakeRealStdout();
    const { teardown } = createFooterWriter(real as never);
    teardown();
    expect(real.writes[real.writes.length - 1]).toBe(`\x1b[r`);
  });

  it("resize events update contentStdout.rows and re-apply the margin", () => {
    const real = fakeRealStdout();
    const { contentStdout, writeFooter } = createFooterWriter(real as never);
    writeFooter(["a", "b", "c"]);
    real.rows = 30;
    real.emit("resize");
    expect(contentStdout.rows).toBe(27);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/footerWriter.test.ts`
Expected: FAIL — cannot resolve `../src/ui/footerWriter.js`.

- [ ] **Step 3: Write `src/ui/footerWriter.ts`**

```ts
// Simplified counterpart to the abandoned dual-Ink-instance design's
// terminalRegions.ts (see docs/superpowers/specs/2026-07-12-hand-rolled-footer-design.md
// for why this is simpler): there is no wrapped log-update instance to
// interoperate with here, so writeFooter always knows its own exact row
// count directly from lines.length. It still must protect content's Ink
// instance's cursor (save -> position -> write -> restore), because
// content is a normal, unmodified Ink instance doing its own relative
// repaint math via its own internal log-update, trusting nothing else
// moves the cursor between its own writes.
import ansiEscapes from "ansi-escapes";

const ESC = "\x1b[";

export interface FooterWriter {
  contentStdout: NodeJS.WriteStream;
  writeFooter(lines: string[]): void;
  teardown(): void;
}

export function createFooterWriter(stdout: NodeJS.WriteStream): FooterWriter {
  let footerRows = 0;
  const listeners = new Set<() => void>();

  const applyMargin = () => {
    const bottom = Math.max(1, (stdout.rows ?? 24) - footerRows);
    stdout.write(`${ESC}1;${bottom}r`);
  };
  applyMargin();

  const contentStdout = {
    write: (data: string) => stdout.write(data),
    get columns() { return stdout.columns; },
    get rows() { return Math.max(1, (stdout.rows ?? 24) - footerRows); },
    get isTTY() { return stdout.isTTY; },
    on: (event: string, cb: () => void) => { if (event === "resize") listeners.add(cb); },
    off: (event: string, cb: () => void) => { if (event === "resize") listeners.delete(cb); }
  } as unknown as NodeJS.WriteStream;

  const onResize = () => {
    applyMargin();
    for (const cb of listeners) cb();
  };
  stdout.on("resize", onResize);

  return {
    contentStdout,
    writeFooter(lines: string[]) {
      const previousRows = footerRows;
      const newRows = lines.length;
      const rowsChanged = newRows !== previousRows;
      if (rowsChanged) {
        footerRows = newRows;
        applyMargin();
      }
      const realRows = stdout.rows ?? 24;
      const origin = realRows - newRows + 1;
      let out = ansiEscapes.cursorSavePosition;
      // If the new frame is shorter than the previous one, the rows that
      // are no longer part of the frame still have the old frame's content
      // on screen and must be explicitly cleared — there is no log-update
      // to inherit an erase-prefix from, and nothing else will ever touch
      // those rows again once they're outside the margin's excluded range.
      if (rowsChanged && newRows < previousRows) {
        const oldOrigin = realRows - previousRows + 1;
        for (let row = oldOrigin; row < origin; row++) {
          out += ansiEscapes.cursorTo(0, row - 1) + "\x1b[2K";
        }
      }
      out += ansiEscapes.cursorTo(0, origin - 1);
      out += lines.join("\r\n");
      out += ansiEscapes.cursorRestorePosition;
      stdout.write(out);
    },
    teardown() {
      stdout.off("resize", onResize);
      stdout.write(`${ESC}r`);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/footerWriter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/ui/footerWriter.ts tests/footerWriter.test.ts
git commit -m "feat(ui): DECSTBM margin + cursor-safe footer writer"
```

---

### Task 4: Wire it together — `cli.tsx` and `App.tsx`

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx` (adjust for removed `InputBox`/`StatusBar`/`useInput`)
- Test: `tests/footerController.test.ts` (new, for the stdin-driving glue)

**Interfaces:**
- Consumes from Tasks 1–3: `FooterState`, `parseStdinChunk`, `renderFooterLines`, `createFooterWriter`.
- `App` needs an `onFooterData` callback prop (parallel to the abandoned design's `onFooterProps`, but simpler — no React bus needed since the footer isn't a React tree): `onFooterData?: (data: StatusBarData & { disabled: boolean; onSubmit(text: string): void; onEscape(): void; onShiftTab(): void; onCtrlC(): void }) => void`.

**Context:** Read the current `src/ui/App.tsx` and `src/cli.tsx` (both on `master`, pre-dual-instance — `App.tsx` currently still renders `InputBox`/`StatusBar` directly and owns a `useInput` hook for escape/shift-tab/ctrl-c) fully before starting. This task removes that JSX and hook from `App.tsx` (same extraction `App.tsx` needs regardless of footer mechanism) and replaces `cli.tsx`'s single `render(<Root />)` call with: one Ink instance for `Root`/`App` using `createFooterWriter`'s `contentStdout`, plus a plain (non-Ink) footer controller that owns `process.stdin`, drives `FooterState` and `renderFooterLines`/`writeFooter`, and receives `App`'s data via the callback.

- [ ] **Step 1: Remove `InputBox`/`StatusBar` JSX and the `useInput` hook from `src/ui/App.tsx`**, replacing them with an effect that calls `props.onFooterData` whenever the relevant state changes — same pattern as the abandoned design's `onFooterProps` effect (`App.tsx`'s dependency-array-driven `useEffect`), but the payload shape matches this plan's simpler interface (no `onRowsChange`, no `columns`/`history`/`completionCtx` — those now live entirely in the footer controller, not passed from `App`). Determine the exact prop shape by reading what `App.tsx`'s current `useInput` handler and `InputBox`/`StatusBar` JSX actually consume, and write the interface precisely — don't guess field names.

- [ ] **Step 2: Write `src/cli.tsx`**, structured as:
  1. Parse args, load providers/settings (unchanged from current `master`).
  2. `const writer = createFooterWriter(process.stdin === process.stdout ? ... : process.stdout as NodeJS.WriteStream)` — call `createFooterWriter(process.stdout)`.
  3. `process.stdin.setRawMode(true)` once, directly — the footer controller's sole ownership of raw mode (no Ink `useInput` involved for it at all).
  4. A `FooterState` instance, constructed once with the initial `completionCtx`/`history`/`columns`/`disabled` and an `onSubmit` that forwards into whatever `App` last provided via `onFooterData`.
  5. A `process.stdin.on("data", chunk => { const { input, key } = parseStdinChunk(chunk); footerState.handleKey(input, key); render(); })` loop, where `render()` calls `renderFooterLines(footerState.snapshot(), columns, disabled, latestStatusData, theme)` and `writer.writeFooter(lines)`.
  6. Escape/Shift+Tab/Ctrl+C handling: intercept these in the same `data` handler (checking `key.escape`/`key.tab && key.shift`/`key.ctrl && input === "c"`) before or alongside `footerState.handleKey`, calling the callbacks `App` provided.
  7. `render(<Root />, { stdout: writer.contentStdout })` for the single Ink instance.
  8. `process.on("exit", writer.teardown)` and `process.on("SIGINT", ...)` (mirroring the abandoned design's exit handling).
  9. On terminal resize, recompute `columns` for `FooterState.setColumns` and re-render the footer.

  Write this out in full, following the exact structure of the CURRENT `master` `src/cli.tsx` for the parts that don't change (arg parsing, provider loading, the `Root` component, project-switching) — only the footer-related wiring is new. Do not invent new CLI flags or settings not already present.

- [ ] **Step 3: Write `tests/footerController.test.ts`** covering the stdin-to-render glue in isolation — if the glue logic from Step 2 isn't naturally extractable into a testable function (e.g. it's tightly coupled to `process.stdin`/`process.stdout`), extract the pure parts (the `render()` function's line-computation, the key-routing decision of "does this go to FooterState or to the escape/shift-tab/ctrl-c handlers") into a small testable unit first, then test that. Follow the existing pattern in `tests/cli.test.ts` (if present on this codebase's history) for how prior `cli.tsx` logic was made testable.

- [ ] **Step 4: Update `tests/app.test.tsx`** for `App.tsx`'s removed `InputBox`/`StatusBar`/`useInput` — read the current test file fully, identify every test that exercises submit/permission/escape/shift-tab flows through the old JSX, and adapt them to drive `App` via its new `onFooterData` callback contract instead (calling the callback's exposed `onSubmit`/`onEscape`/etc. functions directly, the way a real footer controller would, rather than simulating keypresses into `InputBox`).

- [ ] **Step 5: Run the full relevant test set**

Run: `npx vitest run tests/footerKeys.test.ts tests/footerState.test.ts tests/footerRender.test.ts tests/footerWriter.test.ts tests/footerController.test.ts tests/app.test.tsx`
Expected: all PASS.

Run: `npx vitest run`
Expected: all pass except the pre-existing, unrelated `tests/skills.test.ts` environmental failures (verify the count is still exactly 7 — if different, investigate before proceeding).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Manual real-terminal verification (required, not automatable)**

Run `npm run dev` (or the project's dev entry point) in a real terminal (VS Code integrated terminal at minimum). Confirm, in order:
1. App starts; input box + status bar render at the bottom with the correct visual style (rounded border, colors).
2. Typing works, including `/` triggering the suggestion menu, arrow keys navigating it, Tab/Enter accepting.
3. History recall (up/down arrows) works.
4. Backtick line-continuation (typing a line ending in `\` then Enter) works.
5. Submitting a message and receiving a response works end-to-end.
6. Once the transcript exceeds one screen, scrolling the terminal viewport with the mouse wheel moves only the transcript — the footer stays fixed at the bottom, uncorrupted.
7. Resizing the terminal pane adapts the footer without corruption.
8. Ctrl+C twice exits cleanly; the shell is back to normal afterward (no leftover scroll-margin restriction).

- [ ] **Step 7: Commit**

```bash
git add src/cli.tsx src/ui/App.tsx tests/footerController.test.ts tests/app.test.tsx
git commit -m "feat(ui): wire hand-rolled footer into cli.tsx, remove InputBox/StatusBar from App's Ink tree"
```
