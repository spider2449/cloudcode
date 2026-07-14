# Inline Scrollback TUI (Claude Code-style rendering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native mouse text selection, copy, and wheel scrolling work in the cloudcode native TUI by replacing the alt-screen full-repaint renderer with Claude Code-style inline rendering.

**Architecture:** Drop the alternate screen. Completed transcript items are printed into the terminal's normal scrollback exactly once ("committed") and never redrawn — the terminal owns that region, so selection/copy/wheel work natively. Only a dynamic bottom block (streaming tail, work indicator, compact progress, input box or overlay, status bar) is repainted each frame, by moving the cursor up over the previous block with relative escapes and erasing down. The app's hand-rolled scrollback (PgUp/PgDn/Home/End/wheel, scrollOffset, welcome pinning) is deleted — the terminal's own scrollback replaces it.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node >= 18, vitest.

## Global Constraints

- All code comments in English (user's global CLAUDE.md rule).
- Run tests with `npx vitest run <file>` (or `npm test` for the whole suite).
- Every frame must use only cursor-relative movement (`\r`, `\x1b[NA`, `\x1b[0J`) for the dynamic block — never absolute `cursorTo` positioning and never `\x1b[2J` (except Ctrl+L / clear-session, which intentionally clear the viewport).
- The dynamic block must never exceed `rows - 1` lines, otherwise the cursor-up count would move above the viewport top and corrupt the frame.
- Committed transcript rows are laid out at the width current at commit time and are never re-laid-out (same as Claude Code / Ink `<Static>`).
- The working tree already has uncommitted modifications (`src/cli.tsx`, `src/ui/*`). Commit only the files each task names; leave unrelated modified files untouched.

## Known accepted limitations (do not "fix" these)

- Shrinking the terminal reflows committed scrollback rows; already-printed lines may re-wrap oddly. Claude Code has the same artifact.
- The status-bar elapsed clock freezes while idle (the tick repaint is skipped when nothing is animating, so an idle app writes zero bytes and never disturbs a selection).

---

### Task 1: Relative-movement ANSI helpers

**Files:**
- Modify: `src/ui/term/ansi.ts`
- Test: `tests/ansi.test.ts`

**Interfaces:**
- Produces: `export const ERASE_DOWN = "\x1b[0J"` and `export function cursorUp(n: number): string` (returns `""` for `n <= 0`). Task 3 consumes both. Existing exports are untouched in this task (removals happen in Task 6).

- [ ] **Step 1: Write the failing test**

Append to `tests/ansi.test.ts` (add `ERASE_DOWN`, `cursorUp` to the existing import from `../src/ui/term/ansi.js`):

```ts
describe("relative movement helpers", () => {
  it("ERASE_DOWN clears from cursor to end of screen", () => {
    expect(ERASE_DOWN).toBe("\x1b[0J");
  });

  it("cursorUp emits CUU for positive counts", () => {
    expect(cursorUp(3)).toBe("\x1b[3A");
    expect(cursorUp(1)).toBe("\x1b[1A");
  });

  it("cursorUp emits nothing for zero or negative counts", () => {
    expect(cursorUp(0)).toBe("");
    expect(cursorUp(-2)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ansi.test.ts`
Expected: FAIL — `ERASE_DOWN` / `cursorUp` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/ui/term/ansi.ts`:

```ts
// Erase from the cursor to the end of the screen. Used by the inline
// renderer to wipe the previous dynamic block before repainting it.
export const ERASE_DOWN = "\x1b[0J";

export function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ansi.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/ansi.ts tests/ansi.test.ts
git commit -m "feat(ui): add relative-movement ANSI helpers for inline rendering"
```

---

### Task 2: Buffer commit semantics

**Files:**
- Modify: `src/ui/buffer.ts`
- Test: `tests/buffer.test.ts`

**Interfaces:**
- Consumes: `layoutItem(item, theme, width): string[]` from `src/ui/layout.js` (unchanged).
- Produces: `Buffer.takeCommitRows(width: number, theme: Theme): string[]` — lays out every not-yet-committed item at the given width, marks them committed, returns their rows (empty array when nothing new). `Buffer.clear()` also resets the committed marker. `append(item)` and `itemCount` keep their current signatures. `visibleWindow` and `totalRows` are DELETED (their only consumer was the old renderer/scroll code removed in Tasks 3–4).

- [ ] **Step 1: Rewrite the test file**

Replace the body of `tests/buffer.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";

const theme = THEMES.dark;

describe("Buffer commit semantics", () => {
  it("takeCommitRows returns nothing for an empty buffer", () => {
    const buf = new Buffer();
    expect(buf.takeCommitRows(80, theme)).toEqual([]);
  });

  it("returns rows for appended items exactly once", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "one" });
    buf.append({ kind: "notice", text: "a\nb\nc" });
    const first = buf.takeCommitRows(80, theme);
    expect(first.length).toBe(4); // 1 + 3 laid-out rows
    expect(first.join("\n")).toContain("one");
    // Second call: nothing new was appended, nothing is re-emitted.
    expect(buf.takeCommitRows(80, theme)).toEqual([]);
  });

  it("items appended after a commit are returned by the next commit", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "first" });
    buf.takeCommitRows(80, theme);
    buf.append({ kind: "notice", text: "second" });
    const rows = buf.takeCommitRows(80, theme);
    expect(rows.join("\n")).toContain("second");
    expect(rows.join("\n")).not.toContain("first");
  });

  it("wraps uncommitted items at the width passed to takeCommitRows", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "aaaa bbbb" });
    expect(buf.takeCommitRows(4, theme).length).toBeGreaterThan(1);
  });

  it("clear() resets the committed marker so re-appended items commit again", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "x" });
    buf.takeCommitRows(80, theme);
    buf.clear();
    expect(buf.itemCount).toBe(0);
    buf.append({ kind: "notice", text: "y" });
    expect(buf.takeCommitRows(80, theme).join("\n")).toContain("y");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buffer.test.ts`
Expected: FAIL — `takeCommitRows` does not exist.

- [ ] **Step 3: Rewrite the implementation**

Replace the body of `src/ui/buffer.ts` with:

```ts
import type { DisplayItem } from "./transcript.js";
import { layoutItem } from "./layout.js";
import type { Theme } from "./theme.js";

/**
 * Holds transcript items and tracks which of them have already been
 * committed (printed once into the terminal's normal scrollback).
 * Committed items are never laid out or emitted again.
 */
export class Buffer {
  private items: DisplayItem[] = [];
  private committed = 0;

  append(item: DisplayItem): void {
    this.items.push(item);
  }

  get itemCount(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.committed = 0;
  }

  /** Lay out all not-yet-committed items and mark them committed. */
  takeCommitRows(width: number, theme: Theme): string[] {
    const rows: string[] = [];
    for (; this.committed < this.items.length; this.committed++) {
      rows.push(...layoutItem(this.items[this.committed], theme, width));
    }
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/buffer.test.ts`
Expected: PASS. (`npm test` will still fail overall because `render.ts`/`nativeApp.ts` reference the deleted methods — that is expected until Tasks 3–4; do NOT commit yet if the tree doesn't compile. Instead, verify compilation is only broken in `src/ui/term/render.ts` and `src/ui/nativeApp.ts`, which Task 3 and 4 rewrite. To keep every commit green, Task 2 and Task 3 are committed together at the end of Task 3.)

---

### Task 3: InlineRenderer replacing full-screen render()

**Files:**
- Rewrite: `src/ui/term/render.ts`
- Test: `tests/render.test.ts` (rewrite)

**Interfaces:**
- Consumes: `Buffer.takeCommitRows(width, theme)` (Task 2), `ERASE_DOWN`, `cursorUp` (Task 1), existing widget renderers (`renderStatusBar`, `renderWorkInd`, `renderProgress`, `tailForHeight`).
- Produces:

```ts
export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  activeTool?: string;
  compactPct?: number;
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}
// (identical to today's BottomState minus the scrollOffset field)

export class InlineRenderer {
  frame(buffer: Buffer, bottom: BottomState, theme: Theme,
        size: { rows: number; columns: number }): string;
  /** Forget the previous dynamic block, e.g. after a full-screen clear. */
  invalidate(): void;
  /** Terminal bytes that park the cursor on a fresh line below the UI on exit. */
  finalize(): string;
}
```

The old `render()` function is deleted. Task 4 switches `nativeApp.ts` to this class.

- [ ] **Step 1: Rewrite the test file**

Replace `tests/render.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { InlineRenderer, type BottomState } from "../src/ui/term/render.js";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";

const theme = THEMES.dark;
const size = { rows: 24, columns: 80 };

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
    inputRender: emptyInputRender(),
    overlayRows: [],
    statusBarProps: { provider: "anthropic", mode: "default", cwd: "/repo" },
    workIndFrame: 0,
    workStartedAt: 0,
    ...overrides
  };
}

describe("InlineRenderer", () => {
  it("never emits a full-screen clear or absolute cursor positioning", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "hello" });
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toMatch(/\x1b\[\d+;\d+H/);
  });

  it("emits committed transcript rows exactly once across frames", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "STATIC_MARKER" });
    const first = r.frame(buf, baseBottom(), theme, size);
    const second = r.frame(buf, baseBottom(), theme, size);
    expect(first).toContain("STATIC_MARKER");
    expect(second).not.toContain("STATIC_MARKER");
  });

  it("static rows end with CRLF so the dynamic block starts on its own line", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "hello" });
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toMatch(/hello\S*\r\n/);
  });

  it("second frame moves up over the previous dynamic block and erases down", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const first = r.frame(buf, baseBottom(), theme, size);
    // Dynamic block: 2 border rows + 1 content row + 1 status bar = 4 lines,
    // cursor rests on the last one, so the next frame moves up 3.
    const second = r.frame(buf, baseBottom(), theme, size);
    expect(first.startsWith("\r\x1b[0J")).toBe(true); // nothing to move over yet
    expect(second.startsWith("\r\x1b[3A\x1b[0J")).toBe(true);
  });

  it("repaints the dynamic block (status bar redrawn every frame)", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const first = r.frame(buf, baseBottom(), theme, size);
    const second = r.frame(buf, baseBottom(), theme, size);
    expect(first).toContain("anthropic");
    expect(second).toContain("anthropic");
  });

  it("renders the open overlay instead of the input box", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom({ overlay: "resume", overlayRows: ["OVERLAY_MARKER"] }), theme, size);
    expect(out).toContain("OVERLAY_MARKER");
    expect(out).not.toContain("╭─╮");
  });

  it("caps a tall streaming preview so the dynamic block fits the viewport", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = r.frame(buf, baseBottom({ streaming: true, streamingText: longText }), theme, size);
    expect(out).not.toContain("line 0");
    expect(out).toContain("line 49");
    // Dynamic block must stay under rows lines: strictly fewer than 24 CRLFs.
    expect(out.split("\r\n").length).toBeLessThan(24);
  });

  it("invalidate() forgets the previous block so the next frame does not move up", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    r.frame(buf, baseBottom(), theme, size);
    r.invalidate();
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out.startsWith("\r\x1b[0J")).toBe(true);
  });

  it("finalize() parks the cursor on a fresh line", () => {
    const r = new InlineRenderer();
    expect(r.finalize()).toBe("\r\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — `InlineRenderer` is not exported.

- [ ] **Step 3: Rewrite the implementation**

Replace `src/ui/term/render.ts` with:

```ts
import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { ERASE_DOWN, cursorUp } from "./ansi.js";
import type { Theme } from "../theme.js";

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  activeTool?: string;
  compactPct?: number;
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}

/**
 * Claude Code-style inline renderer. Transcript rows are printed once into
 * the terminal's normal scrollback and never touched again, so native mouse
 * selection, copy, and wheel scrolling work in the message area. Only the
 * dynamic bottom block (streaming tail, indicators, input box or overlay,
 * status bar) is repainted, using cursor-relative movement.
 */
export class InlineRenderer {
  // Number of lines the cursor must travel up to reach the first line of the
  // previously painted dynamic block (block height minus one, since the
  // cursor parks on the block's last line).
  private lastDynamicLines = 0;

  frame(
    buffer: Buffer,
    bottom: BottomState,
    theme: Theme,
    size: { rows: number; columns: number }
  ): string {
    const { rows, columns } = size;

    // Dynamic block, built bottom-up (same assembly as the old renderer).
    const dyn: string[] = [];
    dyn.push(renderStatusBar(bottom.statusBarProps, theme, columns));
    if (bottom.overlay !== "none") {
      dyn.unshift(...bottom.overlayRows);
    } else {
      dyn.unshift(...bottom.inputRender.menuRows);
      if (bottom.inputRender.hintRow !== null) dyn.unshift(bottom.inputRender.hintRow);
      dyn.unshift(...bottom.inputRender.contentRows);
      dyn.unshift(...bottom.inputRender.borderRows);
    }
    if (bottom.compactPct !== undefined) dyn.unshift(renderProgress("Compacting", bottom.compactPct, theme, 20));
    if (bottom.streaming) dyn.unshift(renderWorkInd(bottom.workIndFrame, bottom.activeTool ? `Running ${bottom.activeTool}` : "Thinking", Date.now() - bottom.workStartedAt, theme));
    if (bottom.streamingText !== "") {
      const streamTailCap = Math.max(3, rows - dyn.length - 3);
      dyn.unshift(...tailForHeight(bottom.streamingText, streamTailCap, columns).split("\n"));
    }

    // Cap the block below the viewport height: moving the cursor up more
    // rows than the viewport has would corrupt the frame.
    const visible = dyn.slice(Math.max(0, dyn.length - (rows - 1)));

    const staticRows = buffer.takeCommitRows(columns, theme);
    const out =
      "\r" + cursorUp(this.lastDynamicLines) + ERASE_DOWN +
      staticRows.map(r => r + "\r\n").join("") +
      visible.join("\r\n");
    this.lastDynamicLines = Math.max(0, visible.length - 1);
    return out;
  }

  invalidate(): void {
    this.lastDynamicLines = 0;
  }

  finalize(): string {
    this.lastDynamicLines = 0;
    return "\r\n";
  }
}
```

Note: `renderStatusBar` today receives `{ ...props, scrollHint: scrollOffset !== null }`. The `scrollHint` argument is gone here; Task 5 removes the prop from the widget. Until Task 5, passing props without `scrollHint` must still compile — if `scrollHint` is a required field of `StatusBarProps`, pass `scrollHint: false` here temporarily and delete it in Task 5.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/render.test.ts tests/buffer.test.ts tests/ansi.test.ts`
Expected: PASS. (`nativeApp.ts` still references the old `render()` and `scrollOffset` — full `npm test` stays red until Task 4.)

- [ ] **Step 5: Commit Tasks 2+3 together (first compiling point)**

Only if `npx tsc -p tsconfig.json --noEmit` reports errors solely in `src/ui/nativeApp.ts` (expected until Task 4), proceed to Task 4 first and commit there instead. If it compiles, commit now:

```bash
git add src/ui/buffer.ts tests/buffer.test.ts src/ui/term/render.ts tests/render.test.ts
git commit -m "feat(ui): inline renderer with commit-once transcript buffer"
```

---

### Task 4: Wire nativeApp + terminal to inline rendering; delete hand-rolled scrolling

**Files:**
- Modify: `src/ui/nativeApp.ts`
- Modify: `src/ui/term/terminal.ts`
- Test: `tests/app.test.ts` (update), `tests/terminal.test.ts` (unchanged, re-run)

**Interfaces:**
- Consumes: `InlineRenderer` (Task 3), `Buffer.takeCommitRows` (Task 2), `CLEAR_AND_HOME` (existing).
- Produces: `App` public surface unchanged (`handleKey`, `handleKeys`, `handleMessage`, `recompute`, `tick`, `run`). The `scrollOffset`, `welcomePinned`, `startupItemCount` fields and all PgUp/PgDn/Home/End/wheel scroll handling are deleted.

- [ ] **Step 1: Update app tests**

In `tests/app.test.ts`:
1. DELETE the three scroll tests: "PgUp sets a concrete scrollOffset…", "mouse wheel up scrolls back…", "End resets scrollOffset…".
2. ADD (adapt the surrounding test setup helpers already in that file — they construct `App` with a `FakeTerminal`):

```ts
it("transcript items are written to the terminal exactly once", async () => {
  // ...use the file's existing App+FakeTerminal setup helper...
  app.recompute();
  const before = term.writes.join("");
  app.handleKey({ t: "printable", ch: "x" }); // triggers another recompute
  const after = term.writes.join("").slice(before.length);
  // The welcome banner was committed in the first frame and must not be
  // re-emitted by later frames.
  expect(before).toContain("cloudcode"); // or a stable welcome substring used elsewhere in this file
  expect(after).not.toContain("\x1b[2J");
});

it("tick() writes nothing while idle so a mouse selection survives", async () => {
  app.recompute();
  const count = term.writes.length;
  app.tick();
  expect(term.writes.length).toBe(count);
});
```

(If the welcome substring assertion is brittle, assert on a `notice()` marker instead: call a slash command that appends a notice, recompute twice, and check the notice text appears in exactly one write.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL (new tests fail; file may not even compile yet — fine).

- [ ] **Step 3: Rewrite nativeApp rendering/scroll code**

In `src/ui/nativeApp.ts`:

1. Imports: replace `import { render, type BottomState } from "./term/render.js";` with `import { InlineRenderer, type BottomState } from "./term/render.js";` and add `import { CLEAR_AND_HOME } from "./term/ansi.js";`.
2. Fields: delete `scrollOffset`, `welcomePinned`, `startupItemCount`. Add `private renderer = new InlineRenderer();`.
3. `appendWelcome()`: delete the `welcomePinned = true` line and its comment (the banner simply commits to scrollback). Delete the `startupItemCount` assignment in the constructor.
4. `tick()`: skip repaints when nothing animates, so an idle app writes zero bytes:

```ts
tick(): void {
  if (this.phase === "idle" && this.compactPct === undefined) return;
  this.workIndFrame += 1;
  this.recompute();
}
```

5. `handleKey()` Phase 2: DELETE the whole scrollback-navigation block (the `if (this.overlay.mode === "none") { ... pgup/pgdn/home/end/wheel ... }` at lines ~455-491). Home/End/PgUp/PgDn keys now fall through to `inputBox.handleKey` / overlay like any other key; `wheel` keys can no longer arrive (mouse reporting is off) and are ignored by the input box — leave the decoder in `src/ui/input.ts` untouched as defensive parsing against a terminal left in mouse mode by a previous program.
6. Ctrl+L becomes a real viewport clear (transcript stays in terminal scrollback above, like Claude Code):

```ts
if (k.t === "ctrl" && k.ch === "l") {
  this.terminal.write(CLEAR_AND_HOME);
  this.renderer.invalidate();
  this.recompute();
  return;
}
```

7. Everywhere `this.buffer.clear()` is called (`clearSession` at ~line 295-296 and `pickResume` at ~line 285), immediately follow with:

```ts
this.terminal.write(CLEAR_AND_HOME);
this.renderer.invalidate();
```

8. `recompute()`: drop `scrollOffset`, `viewOffset`, `welcomePinned` logic and the `scrollHint` spread; call the renderer:

```ts
recompute(): void {
  const size = this.terminal.size();
  const inputVisible = this.overlay.mode === "none" && this.phase !== "permission";
  const bottom: BottomState = {
    overlay: this.overlay.mode,
    streaming: this.phase === "streaming",
    streamingText: this.streamText,
    activeTool: this.activeTool,
    compactPct: this.compactPct,
    inputRender: inputVisible
      ? this.inputBox.render(this.theme, size.columns, this.phase === "streaming")
      : { borderRows: [], contentRows: [], menuRows: [], hintRow: null, totalRows: 0 },
    overlayRows: this.overlay.isOpen ? this.overlay.render(this.theme, size.columns) : [],
    statusBarProps: { /* identical to today's object */ },
    workIndFrame: this.workIndFrame,
    workStartedAt: this.workStartedAt
  };
  this.terminal.write(this.renderer.frame(this.buffer, bottom, this.theme, size));
}
```

9. `stop()`: park the shell prompt below the UI:

```ts
private stop(): void {
  if (this.tickTimer) clearInterval(this.tickTimer);
  this.git.stop();
  this.terminal.write(this.renderer.finalize());
  this.running = false;
  this.stopResolve?.();
}
```

10. In `src/ui/term/terminal.ts`: constructor writes `BRACKETED_PASTE_ON + CURSOR_HIDE + AUTOWRAP_OFF` (drop `ALT_SCREEN_ON`); `cleanup()` writes `AUTOWRAP_ON + BRACKETED_PASTE_OFF + CURSOR_SHOW` (drop `MOUSE_OFF` and `ALT_SCREEN_OFF`). Replace the mouse comment at lines 24-27 with:

```ts
// Inline rendering on the normal screen: the transcript lives in the
// terminal's own scrollback, so native mouse selection, copy, and wheel
// scrolling work without any mouse capture.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. If other app tests assert on `\x1b[2J` frames or absolute cursor rows, update them to the inline-frame expectations (relative movement, commit-once).

- [ ] **Step 5: Commit (include Task 2+3 files if not yet committed)**

```bash
git add src/ui/nativeApp.ts src/ui/term/terminal.ts tests/app.test.ts src/ui/buffer.ts tests/buffer.test.ts src/ui/term/render.ts tests/render.test.ts
git commit -m "feat(ui): render transcript into normal scrollback so native text selection works"
```

---

### Task 5: Remove dead scroll UI (scrollHint, alt-screen/mouse constants)

**Files:**
- Modify: `src/ui/widgets/statusBar.ts` (remove `scrollHint` prop and its rendering)
- Modify: `src/ui/term/ansi.ts` (delete `ALT_SCREEN_ON`, `ALT_SCREEN_OFF`, `MOUSE_ON`, `MOUSE_OFF` and their comments)
- Test: `tests/statusBar.test.tsx`, `tests/ansi.test.ts`, `tests/widgets.test.ts` (whichever reference the deleted items)

- [ ] **Step 1: Delete `scrollHint` from `StatusBarProps` and its render branch in `src/ui/widgets/statusBar.ts`** (grep the file for `scrollHint`; delete the field, the parameter use, and any "Press End" hint copy). Remove the temporary `scrollHint: false` from `render.ts` if Task 3 added it.

- [ ] **Step 2: Delete `ALT_SCREEN_ON/OFF` and `MOUSE_ON/OFF` from `src/ui/term/ansi.ts`.** Run `npx tsc -p tsconfig.json --noEmit`; fix any remaining importer (there must be none in `src/` after Task 4 — if the old Ink UI (`src/ui/App.tsx` etc.) imports them, leave the constants in place and only delete the mouse pair; note which in the commit message).

- [ ] **Step 3: Update tests** — remove alt-screen/mouse constant assertions from `tests/ansi.test.ts` and `scrollHint` cases from the status bar tests.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/statusBar.ts src/ui/term/ansi.ts tests/ansi.test.ts tests/statusBar.test.tsx tests/widgets.test.ts
git commit -m "refactor(ui): drop scroll hint and alt-screen/mouse escape constants"
```

---

### Task 6: Manual end-to-end verification in a real terminal

**Files:** none (verification only). REQUIRED SUB-SKILL for the session doing this: `superpowers:verification-before-completion`.

- [ ] **Step 1: Build and launch the native TUI**

Run: `npm run build`, then in a real Windows Terminal window: `node dist/cli.js --tui` (the native-UI opt-in flag from commit c970546; verify the exact flag with `node dist/cli.js --help`).

- [ ] **Step 2: Verify each behavior**

1. Send a prompt that produces several messages. **Select text in the message area with the mouse** — the selection must persist while idle and while a later response streams. Copy it and confirm the paste matches.
2. **Wheel-scroll** — the terminal's native scrollback must scroll through past messages.
3. While streaming, the spinner/status bar repaint only the bottom block; earlier messages must not flicker.
4. `Ctrl+L` clears the viewport; scrolled-back history is still reachable above.
5. `/new` (clear session) clears the viewport and starts fresh.
6. Resize the window narrower and wider; the input box and status bar must stay usable (minor reflow artifacts in old output are acceptable).
7. Exit (double Ctrl+C); the shell prompt must appear on a fresh line below the status bar, cursor visible.

- [ ] **Step 3: Fix anything broken (return to the relevant task), re-verify, then report results with evidence.**

---

## Self-review notes

- Spec coverage: selection/copy/wheel (Tasks 3–4, verified in 6); no full repaints (Task 3 frame format + tests); idle silence so selections survive (Task 4 tick gate + test); hand-rolled scrolling removed (Task 4); exit/cleanup path (Task 4 steps 9–10, verified in 6 item 7).
- The Ink UI (`App.tsx`, `MessageList.tsx`, …) is untouched; Task 5 step 2 explicitly guards against breaking any constant it imports.
- Type consistency: `takeCommitRows(width, theme)` (Tasks 2, 3), `InlineRenderer.frame/invalidate/finalize` (Tasks 3, 4), `BottomState` without `scrollOffset` (Tasks 3, 4).
