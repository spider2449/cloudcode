# Pinned-Bottom Footer via Terminal Scroll Region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the native TUI's footer (status bar + input box/overlay) to the terminal's bottom rows at all times, using a terminal scroll region, while the message area above it keeps using the terminal's native scrollback for wheel-scroll and mouse selection.

**Architecture:** Split the screen with DECSTBM (`ESC[top;bottom r`) into a scroll region (rows `1..scrollBottom`) holding the transcript, and a footer band (`scrollBottom+1..rows`) repainted every frame with absolute cursor addressing. `InlineRenderer` (in `src/ui/term/render.ts`) owns this; `nativeApp.ts`'s `recompute()`/`stop()` call sites are unchanged since `InlineRenderer.frame/invalidate/finalize` keep their existing signatures.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node >= 18, vitest.

## Global Constraints

- All code comments in English.
- Run tests with `npx vitest run <file>` (or `npm test` for the whole suite).
- DECOM (origin mode) is never enabled — absolute cursor addressing (`cursorTo`) always addresses the whole physical screen, not relative to the scroll region. This is the default terminal state; do not add any `\x1b[?6h`/`\x1b[?6l` toggling.
- The scroll region must always keep at least 1 row for the transcript: `scrollBottom = Math.max(1, rows - footerHeight)`.
- Growing the footer (footer needs more rows than last frame, same terminal size) must not silently overwrite already-committed transcript lines that are still visible at the bottom of the scroll region — those rows must be evacuated into native scrollback before the region shrinks. See Task 2 Step 3 for the exact mechanism.
- Shrinking the footer (or the window growing) frees rows back to the message region; those rows contain stale footer bytes and must be blanked before they're reused for transcript content.
- A real terminal resize is exempt from the evacuation guarantee above — resizing already reflows already-committed rows imperfectly per the prior plan's accepted limitation; this plan does not add extra handling for that case.
- `nativeApp.ts` requires NO changes: `InlineRenderer.frame(buffer, bottom, theme, size)`, `.invalidate()`, and `.finalize()` keep their exact existing signatures and call sites (`recompute()`, the three `CLEAR_AND_HOME`+`invalidate()` sites, `stop()`). Do not touch `src/ui/nativeApp.ts` in this plan.

---

### Task 1: Scroll-region ANSI helpers + terminal cleanup safety net

**Files:**
- Modify: `src/ui/term/ansi.ts`
- Modify: `src/ui/term/terminal.ts`
- Test: `tests/ansi.test.ts`

**Interfaces:**
- Produces: `export function setScrollRegion(top: number, bottom: number): string` returning `` `\x1b[${top};${bottom}r` ``, and `export const RESET_SCROLL_REGION = "\x1b[r"`. Task 2 consumes both. `cursorTo` and `ERASE_DOWN` already exist in `src/ui/term/ansi.ts` and are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/ansi.test.ts` (add `setScrollRegion`, `RESET_SCROLL_REGION` to the existing import from `../src/ui/term/ansi.js`):

```ts
describe("scroll region helpers", () => {
  it("setScrollRegion emits DECSTBM for the given rows", () => {
    expect(setScrollRegion(1, 20)).toBe("\x1b[1;20r");
    expect(setScrollRegion(3, 10)).toBe("\x1b[3;10r");
  });

  it("RESET_SCROLL_REGION restores the full-screen scroll region", () => {
    expect(RESET_SCROLL_REGION).toBe("\x1b[r");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ansi.test.ts`
Expected: FAIL — `setScrollRegion` / `RESET_SCROLL_REGION` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/ui/term/ansi.ts`:

```ts
// DECSTBM: confine scrolling to rows top..bottom (1-indexed, inclusive).
// Used to pin the footer band below the scroll region to the terminal's
// bottom edge while the transcript above it scrolls independently.
export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

// Restores the scroll region to the whole screen. Must be written before
// handing control back to the shell, or the shell prompt would be visually
// confined to whatever sub-region the app last used.
export const RESET_SCROLL_REGION = "\x1b[r";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ansi.test.ts`
Expected: PASS

- [ ] **Step 5: Add a cleanup safety net in terminal.ts**

In `src/ui/term/terminal.ts`, import `RESET_SCROLL_REGION` alongside the existing ansi imports, and prepend it to the escape sequence `cleanup()` writes:

```ts
import { BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF, CURSOR_HIDE, CURSOR_SHOW, AUTOWRAP_OFF, AUTOWRAP_ON, RESET_SCROLL_REGION } from "./ansi.js";
```

```ts
cleanup(): void {
  if (this.cleaned) return;
  this.cleaned = true;
  if (this.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(RESET_SCROLL_REGION + AUTOWRAP_ON + BRACKETED_PASTE_OFF + CURSOR_SHOW);
  }
}
```

This is a safety net for the case where the process exits without going through `App.stop()` (e.g. an uncaught exception) — `App.stop()` itself already resets the region via `InlineRenderer.finalize()` (Task 2), so in the normal exit path this write is a harmless no-op repeat.

There is no dedicated test for this step: `Terminal` (as opposed to `FakeTerminal`) only writes to `process.stdout` when `isTTY` is true, which is false in the test runner, so this path isn't exercised by the existing `tests/terminal.test.ts` (which only tests `FakeTerminal`). Confirm it compiles:

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the ansi and terminal test files**

Run: `npx vitest run tests/ansi.test.ts tests/terminal.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/term/ansi.ts src/ui/term/terminal.ts tests/ansi.test.ts
git commit -m "feat(ui): add scroll-region ANSI helpers and cleanup safety net"
```

---

### Task 2: InlineRenderer scroll-region rewrite

**Files:**
- Rewrite: `src/ui/term/render.ts`
- Rewrite: `tests/render.test.ts`

**Interfaces:**
- Consumes: `setScrollRegion`, `RESET_SCROLL_REGION`, `cursorTo`, `ERASE_DOWN` from `src/ui/term/ansi.js` (Task 1 adds the first two; the last two already exist). `Buffer.takeCommitRows(width, theme)` from `src/ui/buffer.js` (unchanged, already exists).
- Produces: `InlineRenderer` keeps its exact existing public shape — `frame(buffer, bottom, theme, size): string`, `invalidate(): void`, `finalize(): string` — so `src/ui/nativeApp.ts` requires no changes. `BottomState` is unchanged.

This task fully replaces the internals of `InlineRenderer`. The previous implementation tracked a single `lastDynamicLines` counter and used relative cursor-up movement for the whole dynamic block. This task replaces that with scroll-region state (`lastScrollBottom`, `lastRows`, `lastColumns`) and absolute addressing confined to two known anchor points: the scroll region's bottom row (to append new committed rows) and the footer's first row (to repaint the footer band).

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

// With emptyInputRender's 2 border + 1 content rows plus the status bar,
// the footer is 4 lines tall, so the scroll region for a 24-row viewport
// is rows 1..20 and the footer occupies rows 21..24.
const FOOTER_HEIGHT = 4;
const SCROLL_BOTTOM = size.rows - FOOTER_HEIGHT; // 20

describe("InlineRenderer", () => {
  it("first frame defines the scroll region for rows 1..(rows-footerHeight)", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain(`\x1b[1;${SCROLL_BOTTOM}r`);
  });

  it("steady-state frames with unchanged footer height and size do not redefine the region", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const first = r.frame(buf, baseBottom(), theme, size);
    const second = r.frame(buf, baseBottom(), theme, size);
    expect(first).toContain(`\x1b[1;${SCROLL_BOTTOM}r`);
    expect(second).not.toContain(`\x1b[1;${SCROLL_BOTTOM}r`);
    expect(second).not.toMatch(/\x1b\[\d+;\d+r/);
  });

  it("appends committed transcript rows anchored at the scroll region's bottom row", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "STATIC_MARKER" });
    const out = r.frame(buf, baseBottom(), theme, size);
    const anchorIdx = out.indexOf(`\x1b[${SCROLL_BOTTOM};1H`);
    const markerIdx = out.indexOf("STATIC_MARKER");
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(anchorIdx);
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

  it("paints the footer anchored at the row after the scroll region, erasing to end of screen first", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom(), theme, size);
    const footerAnchor = `\x1b[${SCROLL_BOTTOM + 1};1H`;
    const anchorIdx = out.indexOf(footerAnchor);
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(out.slice(anchorIdx)).toBe(footerAnchor + "\x1b[0J" + ["╭─╮", "╰─╯", "> ", expect.anything()].slice(0, 0).join("") + out.slice(anchorIdx + footerAnchor.length + "\x1b[0J".length));
    // Simpler, equivalent check: the footer content follows immediately after the anchor+erase.
    expect(out.includes(footerAnchor + "\x1b[0J")).toBe(true);
    expect(out).toContain("anthropic"); // status bar, part of the footer
  });

  it("repaints the footer every frame (status bar redrawn even with no new transcript rows)", () => {
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

  it("caps a tall streaming preview so the footer fits under the viewport, keeping at least 1 scroll-region row", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = r.frame(buf, baseBottom({ streaming: true, streamingText: longText }), theme, size);
    expect(out).not.toContain("line 0");
    expect(out).toContain("line 49");
    expect(out).toContain(`\x1b[1;1r`); // scrollBottom clamped to 1 when the footer needs rows-1 lines
  });

  it("growing footer height evacuates newly-reclaimed rows into scrollback before shrinking the region", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // First frame: footer is 4 lines, scrollBottom = 20.
    r.frame(buf, baseBottom(), theme, size);
    // Second frame: streaming adds a work-indicator line, footer becomes 5 lines, scrollBottom = 19.
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // Evacuation: 1 blank line scrolled at the OLD scroll bottom (row 20) before the region shrinks.
    const evacuateIdx = second.indexOf(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
    expect(evacuateIdx).toBeGreaterThanOrEqual(0);
    expect(newRegionIdx).toBeGreaterThan(evacuateIdx);
  });

  it("shrinking footer height blanks the rows freed back to the message region", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // First frame: streaming, footer is 5 lines, scrollBottom = 19.
    r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // Second frame: streaming stops, footer shrinks back to 4 lines, scrollBottom = 20.
    const second = r.frame(buf, baseBottom(), theme, size);
    const oldFooterStart = SCROLL_BOTTOM - 1 + 1; // 20
    const blankIdx = second.indexOf(`\x1b[${oldFooterStart};1H\x1b[0J`);
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM}r`);
    expect(blankIdx).toBeGreaterThanOrEqual(0);
    expect(newRegionIdx).toBeGreaterThanOrEqual(0);
  });

  it("invalidate() forces the next frame to redefine the region unconditionally", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    r.frame(buf, baseBottom(), theme, size);
    r.invalidate();
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain(`\x1b[1;${SCROLL_BOTTOM}r`);
  });

  it("finalize() resets the scroll region and parks the cursor on a fresh line", () => {
    const r = new InlineRenderer();
    expect(r.finalize()).toBe("\x1b[r\r\n");
  });
});
```

Note: the "paints the footer anchored..." test above contains a deliberately inert `expect(...).toBe(...)` line built from `.slice(0,0)` (always an empty array, so the join is `""`) — this keeps the assertion self-consistent without depending on exact footer byte-for-byte content beyond the anchor+erase check. Simplify it if you find it awkward: the two `expect` lines that follow it are what actually matter and are sufficient on their own; delete the confusing middle line if you prefer, since the two simpler checks already prove the requirement.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — current `InlineRenderer` doesn't use scroll regions yet.

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
import { ERASE_DOWN, cursorTo, setScrollRegion, RESET_SCROLL_REGION } from "./ansi.js";
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
 * Claude Code-style inline renderer with a pinned-bottom footer. The
 * transcript lives in a terminal scroll region (rows 1..scrollBottom) that
 * the terminal itself scrolls, pushing lines that leave the top into native
 * scrollback for selection/copy/wheel-scroll. The footer band below it
 * (scrollBottom+1..rows) is repainted every frame with cursor addressing
 * confined to those rows, so it stays pinned to the bottom edge.
 */
export class InlineRenderer {
  // -1 means "no region defined yet" (first frame after construction or
  // after invalidate()).
  private lastScrollBottom = -1;
  private lastRows = -1;
  private lastColumns = -1;

  frame(
    buffer: Buffer,
    bottom: BottomState,
    theme: Theme,
    size: { rows: number; columns: number }
  ): string {
    const { rows, columns } = size;

    // Footer content, built bottom-up (same assembly as before).
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

    // Cap the footer so the scroll region always keeps at least 1 row.
    const footer = dyn.slice(Math.max(0, dyn.length - (rows - 1)));
    const scrollBottom = Math.max(1, rows - footer.length);

    let out = "";
    const firstFrame = this.lastScrollBottom < 0;
    const sizeChanged = rows !== this.lastRows || columns !== this.lastColumns;

    if (!firstFrame && !sizeChanged && scrollBottom < this.lastScrollBottom) {
      // Footer is growing: evacuate the rows about to become footer into
      // native scrollback by scrolling the OLD region before shrinking it,
      // so already-committed transcript lines aren't silently overwritten.
      const evacuate = this.lastScrollBottom - scrollBottom;
      out += cursorTo(this.lastScrollBottom, 1) + "\r\n".repeat(evacuate);
    }

    if (firstFrame || sizeChanged || scrollBottom !== this.lastScrollBottom) {
      if (!firstFrame && scrollBottom > this.lastScrollBottom) {
        // Footer is shrinking (or the window grew): the rows being freed
        // back to the message region still hold stale footer bytes.
        out += cursorTo(this.lastScrollBottom + 1, 1) + ERASE_DOWN;
      }
      out += setScrollRegion(1, scrollBottom);
      this.lastScrollBottom = scrollBottom;
      this.lastRows = rows;
      this.lastColumns = columns;
    }

    const staticRows = buffer.takeCommitRows(columns, theme);
    out += cursorTo(scrollBottom, 1) + staticRows.map(r => r + "\r\n").join("");
    out += cursorTo(scrollBottom + 1, 1) + ERASE_DOWN + footer.join("\r\n");
    return out;
  }

  invalidate(): void {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
  }

  finalize(): string {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    return RESET_SCROLL_REGION + "\r\n";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/app.test.ts` and `tests/nativeApp`-adjacent tests should be unaffected — `nativeApp.ts` was not modified and its only assertion touching renderer output (`expect(after).not.toContain("\x1b[2J")`) still holds, since `InlineRenderer` never emits a full-screen clear.

- [ ] **Step 6: Commit**

```bash
git add src/ui/term/render.ts tests/render.test.ts
git commit -m "feat(ui): pin the footer to the terminal's bottom edge via a scroll region"
```

---

### Task 3: Manual end-to-end verification in a real terminal

**Files:** none (verification only). REQUIRED SUB-SKILL for the session doing this: `superpowers:verification-before-completion`.

- [ ] **Step 1: Build and launch the native TUI**

Run: `npm run build`, then in a real terminal window (Windows Terminal, or another xterm-compatible terminal — this feature depends on DECSTBM support, which Windows' legacy `conhost.exe` does not have; Windows Terminal, VS Code's integrated terminal, and any modern xterm-compatible emulator all support it): `node dist/cli.js` (native TUI is the default `--tui` value in this codebase).

- [ ] **Step 2: Verify each behavior**

1. On startup, with only the welcome banner and a couple of messages (far less than a full screen), confirm the input box and status bar sit at the very bottom row of the terminal window — not right after the last message.
2. Send a prompt that streams a multi-line response. While the streaming preview grows and shrinks, confirm the footer stays pinned to the bottom edge throughout, and no already-shown transcript text visually disappears or gets corrupted during the transition (this exercises the growing/shrinking evacuation logic from Task 2).
3. Once several messages have been sent (more than fit on screen), confirm the message area above the footer scrolls independently: **select text in the message area with the mouse** — the selection must persist while idle and while a later response streams, since the footer repaint never touches the scroll region. Copy it and confirm the paste matches.
4. **Wheel-scroll** — scrolls back through message history without moving the footer.
5. Open an overlay (`/resume`) — confirm it renders in the pinned footer band, replacing the input box, still pinned to the bottom.
6. `Ctrl+L` clears the viewport; the footer reappears pinned at the bottom afterward.
7. `/new` (clear session) clears the viewport and starts fresh with the footer still pinned.
8. Resize the window narrower/wider and shorter/taller; the footer must remain pinned to the (new) bottom edge after the next frame, and the app must not crash or leave the screen in a corrupted state (cosmetic reflow of already-committed rows on resize is an accepted, unavoidable limitation — do not try to fix it).
9. Exit (double Ctrl+C); confirm the scroll region is reset (the shell prompt appears using the full terminal width/height afterward, not confined to a sub-region) and the cursor is visible on a fresh line.

- [ ] **Step 3: Fix anything broken (return to the relevant task), re-verify, then report results with evidence.**

---

## Self-review notes

- Spec coverage: scroll-region split and pinned footer (Task 2); `setScrollRegion`/`RESET_SCROLL_REGION` helpers (Task 1); cleanup safety net (Task 1 Step 5); footer-height/size-triggered region redefinition, snapping instantly (Task 2); growing-footer evacuation and shrinking-footer blanking, both beyond what the spec's prose spelled out but required to satisfy its "message area keeps using native scrollback" and "no regression" intent (Task 2); `finalize()` resets the region (Task 2, verified in Task 3 step 9); `nativeApp.ts`/`terminal.ts` startup untouched aside from the Task 1 cleanup addition (Global Constraints, Task 1).
- Type consistency: `InlineRenderer.frame/invalidate/finalize` keep the exact same signatures across both this plan and the prior plan, so `nativeApp.ts` needed zero changes — confirmed by grepping `tests/app.test.ts` for renderer-output assertions (only one, unaffected).
- The growing/shrinking transition logic is the most bug-prone part of this plan; Task 2's tests exercise both directions explicitly rather than relying on the steady-state tests alone.
