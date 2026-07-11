# Fixed Footer via Terminal Scroll Margin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manually scrolling the terminal viewport moves only the transcript; InputBox + StatusBar stay fixed to the terminal's bottom rows via a real DECSTBM scroll margin, matching Claude Code.

**Architecture:** Two concurrent Ink `render()` instances share one real terminal. A content instance renders the existing transcript/overlays tree into a shrunk-`rows` stdout proxy; a footer instance renders a new `Footer` (InputBox + StatusBar) tree into a stdout proxy that repositions the cursor to the scroll margin before every write. A coordinator in `terminalRegions.ts` owns the DECSTBM lifecycle and the cursor-repositioning math needed to keep Ink's internal relative-repaint model (`log-update`) correct across two independently-repainting instances.

**Tech Stack:** Ink 5 (`render`, custom `stdout`-like objects), `ansi-escapes` (already a transitive dependency via Ink, used directly here), React 18, vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-fixed-footer-scroll-margin-design.md`

## Global Constraints

- All code, comments, and names in English only.
- No fallback path for terminals without DECSTBM support (target: VS Code integrated terminal, Windows Terminal, xterm-compatible) — a cosmetic no-op margin is acceptable on unsupported terminals, a crash is not.
- The scroll margin must be reset (`\x1b[r`) on process exit and `SIGINT`, or the user's shell stays margin-restricted after cloudcode quits.
- Task 1 is a go/no-go gate: its cursor-multiplexing mechanism must be verified correct (unit tests + real-terminal manual check) before any task that depends on it proceeds.
- Only `InputBox` + `StatusBar` become fixed; `WorkingIndicator`, streaming text tail, `ProgressBar`, `PermissionDialog`, `ResumePicker`/`ProjectPicker`, and `SuggestionMenu` (rendered inside `InputBox`, which does move into the footer — the menu comes with it) — everything else stays part of the content instance's ordinary scrolling output.

---

### Task 1: Cursor-multiplexing spike (go/no-go gate)

**Files:**
- Create: `src/ui/terminalRegions.ts`
- Test: `tests/terminalRegions.test.ts`

**Interfaces:**
- Produces (Task 2 relies on these exact signatures):
  - `eraseLinesPrefix(count: number): string` — reproduces `ansi-escapes`'s `eraseLines(count)` byte-for-byte (verified against the real dependency in tests, not just self-consistently).
  - `stripErasePrefix(data: string, expectedCount: number): string | undefined` — returns the remainder after removing the expected prefix, or `undefined` if `data` doesn't start with it (defensive: signals a tracking mismatch).
  - `countLogUpdateRows(output: string): number` — mirrors `log-update`'s own `previousLineCount = output.split('\n').length` definition exactly (no trimming — the trailing empty segment from the final `\n` is intentionally counted; it's the row the cursor rests on afterward).
  - `createWriteMultiplexer(write: (data: string) => void): { forward(getOriginRow: () => number, data: string): void; reset(): void }` — the core primitive: wraps a raw `write` function (a real `stdout.write` or, in tests, a recording stub) so that calling `.forward(getOriginRow, data)` repositions the cursor correctly before forwarding `data`, tracking rows internally. `reset()` zeroes its internal row-tracking (used when the caller knows the next write is a full repaint at a new origin, e.g. after a margin change).

**Context:** This task has no dependency on Ink, React, or the rest of the codebase — it is pure terminal-protocol logic, deliberately isolated so it can be validated on its own before anything is built on top of it. Read the design doc's "Why naive save/move/restore is wrong, and the corrected mechanism" section (`docs/superpowers/specs/2026-07-12-fixed-footer-scroll-margin-design.md`) for the full reasoning — the summary: Ink delegates repainting to `log-update`, which tracks only "how many lines did I write last frame" and repaints via `ansiEscapes.eraseLines(previousLineCount) + output`, purely relative to wherever the cursor currently sits. Multiplexing two independent instances onto one physical cursor requires, before every write for instance X, restoring the cursor to exactly where X's own last write left it — `origin + (lastHeight - 1)` row, or `origin` itself if `lastHeight` is 0 (log-update emits no positioning at all for its very first write, since `eraseLines(0)` is the empty string).

- [ ] **Step 1: Write the failing tests**

Create `tests/terminalRegions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import ansiEscapes from "ansi-escapes";
import {
  eraseLinesPrefix,
  stripErasePrefix,
  countLogUpdateRows,
  createWriteMultiplexer
} from "../src/ui/terminalRegions.js";

describe("eraseLinesPrefix", () => {
  it("matches the real ansi-escapes.eraseLines output for count 0, 1, and 3", () => {
    expect(eraseLinesPrefix(0)).toBe(ansiEscapes.eraseLines(0));
    expect(eraseLinesPrefix(1)).toBe(ansiEscapes.eraseLines(1));
    expect(eraseLinesPrefix(3)).toBe(ansiEscapes.eraseLines(3));
  });
});

describe("stripErasePrefix", () => {
  it("strips a matching prefix and returns the remainder", () => {
    const data = ansiEscapes.eraseLines(2) + "hello\n";
    expect(stripErasePrefix(data, 2)).toBe("hello\n");
  });

  it("returns the data unchanged when expectedCount is 0 (no prefix to strip)", () => {
    const data = "hello\n";
    expect(stripErasePrefix(data, 0)).toBe("hello\n");
  });

  it("returns undefined when data does not start with the expected prefix", () => {
    const data = "hello\n";
    expect(stripErasePrefix(data, 2)).toBeUndefined();
  });
});

describe("countLogUpdateRows", () => {
  it("counts a single-line output as 2 (content row + trailing newline row)", () => {
    expect(countLogUpdateRows("hello\n")).toBe(2);
  });

  it("counts a three-line output as 4", () => {
    expect(countLogUpdateRows("a\nb\nc\n")).toBe(4);
  });

  it("counts an empty output as 2 (matches log-update's own '\\n'.split('\\n').length)", () => {
    expect(countLogUpdateRows("\n")).toBe(2);
  });
});

describe("createWriteMultiplexer", () => {
  function fakeLogUpdateInstance(originRowGetter: () => number, mux: ReturnType<typeof createWriteMultiplexer>) {
    // Simulates one Ink instance's log-update: tracks its own previousLineCount
    // internally exactly like the real dependency, and calls mux.forward with
    // the same-shaped payload log-update would produce.
    let previousLineCount = 0;
    return {
      render(str: string) {
        const output = str + "\n";
        const data = ansiEscapes.eraseLines(previousLineCount) + output;
        mux.forward(originRowGetter, data);
        previousLineCount = output.split("\n").length;
      }
    };
  }

  it("positions a first write at the origin row with no erase prefix", () => {
    const writes: string[] = [];
    const mux = createWriteMultiplexer(d => writes.push(d));
    const instance = fakeLogUpdateInstance(() => 10, mux);
    instance.render("hello");
    // cursorTo(0, 9) in ansi-escapes 0-indexed API == row 10, col 1 in 1-indexed CUP.
    expect(writes[0]).toBe(ansiEscapes.cursorTo(0, 9) + "hello\n");
  });

  it("positions a second write at origin + (lastHeight - 1), matching where log-update actually left the cursor", () => {
    const writes: string[] = [];
    const mux = createWriteMultiplexer(d => writes.push(d));
    const instance = fakeLogUpdateInstance(() => 10, mux);
    instance.render("hello"); // 1 line -> output "hello\n" -> countLogUpdateRows = 2
    instance.render("world");
    // After the first write, log-update believes the cursor rests at
    // origin + (2 - 1) = row 11 (0-indexed row 10).
    expect(writes[1]).toBe(ansiEscapes.cursorTo(0, 10) + ansiEscapes.eraseLines(2) + "world\n");
  });

  it("stays correct across three writes with growing then shrinking content", () => {
    const writes: string[] = [];
    const mux = createWriteMultiplexer(d => writes.push(d));
    const instance = fakeLogUpdateInstance(() => 5, mux);
    instance.render("a\nb"); // output "a\nb\n" -> countLogUpdateRows = 3
    instance.render("c"); // origin + (3-1) = row 7 (0-indexed 6)
    instance.render("d\ne\nf"); // "c\n" -> countLogUpdateRows = 2 -> origin + (2-1) = row 6 (0-indexed 5)
    expect(writes[1]).toBe(ansiEscapes.cursorTo(0, 6) + ansiEscapes.eraseLines(3) + "c\n");
    expect(writes[2]).toBe(ansiEscapes.cursorTo(0, 5) + ansiEscapes.eraseLines(2) + "d\ne\nf\n");
  });

  it("tracks origin changes: reset() forces the next write to reposition at the origin with no erase prefix", () => {
    const writes: string[] = [];
    const mux = createWriteMultiplexer(d => writes.push(d));
    const instance = fakeLogUpdateInstance(() => 10, mux);
    instance.render("hello");
    mux.reset();
    instance.render("world"); // instance's own previousLineCount is now stale (2) but mux was reset
    // Note: this only stays correct if the CALLER (Task 2's coordinator) also
    // forces the wrapped Ink instance to fully re-render at reset time, since
    // the fake instance's own previousLineCount is unaware of the reset —
    // this test only verifies the multiplexer's half of the contract.
    expect(writes[1]).toBe(ansiEscapes.cursorTo(0, 9) + "world\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terminalRegions.test.ts`
Expected: FAIL — cannot resolve `../src/ui/terminalRegions.js`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/terminalRegions.ts`:

```ts
// Ink delegates all repainting to `log-update` (node_modules/ink/build/log-update.js),
// which tracks only "how many lines did I write last frame" and repaints with a
// purely RELATIVE sequence: ansiEscapes.eraseLines(previousLineCount) + output,
// where eraseLines erases and cursor-ups from wherever the cursor currently is,
// and output (str + "\n") leaves the cursor one row below its own last content
// line. It has no concept of absolute rows and Ink exposes no hook to override
// it. Running two independent Ink instances against one physical terminal
// cursor requires, before every write for a given instance, restoring the
// cursor to exactly where THAT instance's own log-update last left it — this
// module does that by tracking each instance's row count itself and driving
// absolute positioning around each write.
import ansiEscapes from "ansi-escapes";

const ESC = "\x1b[";
const ERASE_LINE = ESC + "2K";
const CURSOR_UP = ESC + "1A";
const CURSOR_LEFT = ESC + "G";

// Reproduces ansi-escapes's eraseLines(count) byte-for-byte (verified against
// the real dependency in tests). Reimplemented locally rather than imported
// so this module's core logic has no runtime dependency on ansi-escapes
// beyond what the tests use to cross-check it.
export function eraseLinesPrefix(count: number): string {
  let clear = "";
  for (let i = 0; i < count; i++) {
    clear += ERASE_LINE + (i < count - 1 ? CURSOR_UP : "");
  }
  if (count) clear += CURSOR_LEFT;
  return clear;
}

export function stripErasePrefix(data: string, expectedCount: number): string | undefined {
  const prefix = eraseLinesPrefix(expectedCount);
  if (!data.startsWith(prefix)) return undefined;
  return data.slice(prefix.length);
}

// Mirrors log-update's own `previousLineCount = output.split('\n').length`
// definition exactly. The trailing empty segment from output's final '\n' is
// intentionally counted — it's the row the cursor rests on after writing, and
// log-update's next eraseLines() call relies on that overshoot to correctly
// clear the full previous frame.
export function countLogUpdateRows(output: string): number {
  return output.split("\n").length;
}

// Wraps a raw write function so that calling .forward(getOriginRow, data)
// repositions the cursor to exactly where the wrapped Ink instance's own
// log-update expects to resume, before forwarding `data` unmodified. Tracks
// `lastHeight` (this instance's own row count, matching log-update's private
// previousLineCount) across calls; `reset()` zeros it for callers that know
// the next write is a full repaint at a new origin (e.g. after the scroll
// margin moves — see Task 2's setFooterRows).
export function createWriteMultiplexer(write: (data: string) => void): {
  forward(getOriginRow: () => number, data: string): void;
  reset(): void;
} {
  let lastHeight = 0;
  return {
    forward(getOriginRow, data) {
      const origin = getOriginRow();
      // 0-indexed row/col for ansiEscapes.cursorTo(x, y).
      const targetRow = lastHeight === 0 ? origin : origin + (lastHeight - 1);
      write(ansiEscapes.cursorTo(0, targetRow - 1) + data);
      const stripped = stripErasePrefix(data, lastHeight);
      // If the prefix doesn't match, the wrapped instance's own previousLineCount
      // has drifted from what this multiplexer tracked (a caller bug, e.g. a
      // missed reset()) — fall back to counting the whole payload's newlines
      // rather than silently miscounting, so the NEXT call at least degrades
      // to "probably wrong by a bounded amount" instead of compounding forever.
      const output = stripped ?? data;
      lastHeight = countLogUpdateRows(output);
    },
    reset() {
      lastHeight = 0;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terminalRegions.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Manual real-terminal verification (go/no-go gate)**

This mechanism depends on `log-update`'s and `ansi-escapes`' exact internal
output format — validate it end-to-end in a real terminal before proceeding
to any task that builds on it. In a scratch file (not committed), write a
small script that opens two `setInterval`-driven "fake log-update" writers
(reusing the `fakeLogUpdateInstance` helper shape from the test above) at
two different fixed origins on the real `process.stdout`, one ticking every
300ms with growing/shrinking multi-line content, the other every 700ms —
run it in VS Code's integrated terminal for ~10 seconds and confirm neither
writer corrupts the other's region (no stray characters, no misplaced
cursor, both regions independently stable). Delete the scratch script
afterward.

**If this fails:** STOP. Do not proceed to Task 2. Report the specific
corruption observed back for a design discussion — this is the explicit
go/no-go gate from the spec.

- [ ] **Step 6: Commit**

```bash
git add src/ui/terminalRegions.ts tests/terminalRegions.test.ts
git commit -m "feat(ui): cursor-multiplexing primitive for dual Ink render instances"
```

---

### Task 2: Full `createRegions` API — stdout proxies, margin lifecycle, resize

**Files:**
- Modify: `src/ui/terminalRegions.ts`
- Test: `tests/terminalRegions.test.ts` (append)

**Interfaces:**
- Consumes from Task 1: `createWriteMultiplexer`.
- Produces (Task 4 relies on these exact signatures):
  - `createRegions(stdout: NodeJS.WriteStream, initialFooterRows: number): Regions`, where:
    ```ts
    export interface Regions {
      contentStdout: NodeJS.WriteStream;
      footerStdout: NodeJS.WriteStream;
      setFooterRows(rows: number): void;
      teardown(): void;
    }
    ```
  - `contentStdout`/`footerStdout` are proxy objects satisfying the subset of `NodeJS.WriteStream` Ink actually uses: `.write(data)`, `.columns`, `.rows`, `.on('resize', cb)`/`.off('resize', cb)` (Ink's `Ink` constructor and `useStdout`'s resize listener both need these — verify the exact set by reading `node_modules/ink/build/ink.js` and `node_modules/ink/build/hooks/use-stdout.js` before finalizing the proxy shape; do not guess beyond what's actually read).

**Context:** Task 1's `createWriteMultiplexer` is the correctness-critical primitive; this task wires it into the actual `stdout` proxies both Ink instances will render into, and adds the DECSTBM margin lifecycle around it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/terminalRegions.test.ts`:

```ts
describe("createRegions", () => {
  function fakeRealStdout() {
    const writes: string[] = [];
    const listeners: Record<string, Array<() => void>> = {};
    return {
      write: (d: string) => { writes.push(d); return true; },
      get columns() { return 80; },
      rows: 24,
      on: (event: string, cb: () => void) => { (listeners[event] ??= []).push(cb); },
      off: (event: string, cb: () => void) => {
        listeners[event] = (listeners[event] ?? []).filter(l => l !== cb);
      },
      emit: (event: string) => { for (const cb of listeners[event] ?? []) cb(); },
      writes,
      listeners
    };
  }

  it("contentStdout.rows is realRows minus the current footer height", () => {
    const real = fakeRealStdout();
    const { contentStdout } = createRegions(real as never, 4);
    expect(contentStdout.rows).toBe(20);
  });

  it("contentStdout.write passes through to the real stdout unmodified", () => {
    const real = fakeRealStdout();
    const { contentStdout } = createRegions(real as never, 4);
    contentStdout.write("hello");
    expect(real.writes).toEqual(["hello"]);
  });

  it("sets the initial scroll margin on creation", () => {
    const real = fakeRealStdout();
    createRegions(real as never, 4);
    // Margin excludes the bottom 4 rows: scrolling region is rows 1..20.
    expect(real.writes).toContain("\x1b[1;20r");
  });

  it("setFooterRows re-issues the margin and updates contentStdout.rows", () => {
    const real = fakeRealStdout();
    const { contentStdout, setFooterRows } = createRegions(real as never, 4);
    setFooterRows(6);
    expect(real.writes).toContain("\x1b[1;18r");
    expect(contentStdout.rows).toBe(18);
  });

  it("setFooterRows is a no-op when the height is unchanged", () => {
    const real = fakeRealStdout();
    const { setFooterRows } = createRegions(real as never, 4);
    const countBefore = real.writes.length;
    setFooterRows(4);
    expect(real.writes.length).toBe(countBefore);
  });

  it("resize events update both proxies' rows/columns and re-apply the margin", () => {
    const real = fakeRealStdout();
    const { contentStdout } = createRegions(real as never, 4);
    real.rows = 30;
    real.emit("resize");
    expect(contentStdout.rows).toBe(26);
    expect(real.writes).toContain("\x1b[1;26r");
  });

  it("teardown resets the margin to full-screen", () => {
    const real = fakeRealStdout();
    const { teardown } = createRegions(real as never, 4);
    teardown();
    expect(real.writes[real.writes.length - 1]).toBe("\x1b[r");
  });

  it("footerStdout writes are positioned at the margin origin via the multiplexer", () => {
    const real = fakeRealStdout();
    const { footerStdout } = createRegions(real as never, 4);
    // realRows=24, footerRows=4 -> origin row = 24 - 4 + 1 = 21 (1-indexed) -> 0-indexed 20.
    footerStdout.write("status\n");
    const last = real.writes[real.writes.length - 1];
    expect(last.startsWith(ansiEscapes.cursorTo(0, 20))).toBe(true);
    expect(last.endsWith("status\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terminalRegions.test.ts -t "createRegions"`
Expected: FAIL — `createRegions` is not exported.

- [ ] **Step 3: Write the implementation**

First, read `node_modules/ink/build/ink.js` and
`node_modules/ink/build/hooks/use-stdout.js` to confirm exactly which
`stdout` members Ink's constructor and `useStdout` read (at minimum
`.write`, `.columns`, `.rows`, `.on('resize', ...)`; confirm there is
nothing else — e.g. `.isTTY` — that either reads directly from the object
you pass to `render()`'s `stdout` option before finalizing the proxy
shape below). Append to `src/ui/terminalRegions.ts`:

```ts
export interface Regions {
  contentStdout: NodeJS.WriteStream;
  footerStdout: NodeJS.WriteStream;
  setFooterRows(rows: number): void;
  teardown(): void;
}

export function createRegions(stdout: NodeJS.WriteStream, initialFooterRows: number): Regions {
  let footerRows = initialFooterRows;
  const contentListeners = new Set<() => void>();
  const footerListeners = new Set<() => void>();
  const footerMux = createWriteMultiplexer(data => stdout.write(data));

  const applyMargin = () => {
    const bottom = Math.max(1, (stdout.rows ?? 24) - footerRows);
    stdout.write(`${ESC}1;${bottom}r`);
  };
  applyMargin();

  const contentStdout = {
    write: (data: string) => stdout.write(data),
    get columns() { return stdout.columns; },
    get rows() { return Math.max(1, (stdout.rows ?? 24) - footerRows); },
    on: (event: string, cb: () => void) => { if (event === "resize") contentListeners.add(cb); },
    off: (event: string, cb: () => void) => { if (event === "resize") contentListeners.delete(cb); }
  } as unknown as NodeJS.WriteStream;

  const footerOrigin = () => (stdout.rows ?? 24) - footerRows + 1;
  const footerStdout = {
    write: (data: string) => { footerMux.forward(footerOrigin, data); return true; },
    get columns() { return stdout.columns; },
    get rows() { return footerRows; },
    on: (event: string, cb: () => void) => { if (event === "resize") footerListeners.add(cb); },
    off: (event: string, cb: () => void) => { if (event === "resize") footerListeners.delete(cb); }
  } as unknown as NodeJS.WriteStream;

  const onResize = () => {
    applyMargin();
    for (const cb of contentListeners) cb();
    for (const cb of footerListeners) cb();
  };
  stdout.on("resize", onResize);

  return {
    contentStdout,
    footerStdout,
    setFooterRows(rows: number) {
      if (rows === footerRows) return;
      footerRows = rows;
      footerMux.reset();
      applyMargin();
    },
    teardown() {
      stdout.off("resize", onResize);
      stdout.write(`${ESC}r`);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terminalRegions.test.ts`
Expected: PASS (all tests from Task 1 and Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/ui/terminalRegions.ts tests/terminalRegions.test.ts
git commit -m "feat(ui): createRegions — dual-stdout proxies and DECSTBM margin lifecycle"
```

---

### Task 3: Lift `Footer.tsx` out of `App.tsx`

**Files:**
- Create: `src/ui/Footer.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/bottomFill.ts` (remove the filler-specific exports; keep `inputBoxRows`/`textRows`)
- Test: `tests/app.test.tsx`, `tests/bottom-fill.test.ts` (remove tests for deleted exports), new `tests/footer.test.tsx`

**Interfaces:**
- Consumes: nothing new — reuses `InputBox`, `StatusBar` unchanged, and the existing `onMenuRowsChange`/`onInputRowsChange` callback pattern from `InputBox` (already built; see `src/ui/InputBox.tsx`).
- Produces (Task 4 relies on this exact signature):
  ```ts
  export interface FooterProps {
    completionCtx: CompletionContext;
    onSubmit(text: string): void;
    disabled: boolean;
    history: History;
    columns: number;
    onRowsChange(rows: number): void; // total footer height: InputBox rows (incl. menu) + StatusBar's 1 row
    provider: string; model?: string; servedModel?: string; mode: string; cwd: string; costUsd: number;
    gitBranch?: string; gitDirty?: boolean; tokens: number; contextPct?: number; elapsedMs: number;
    onEscape(): void; // was App.tsx's useInput escape handler (interrupt), moves here
    onShiftTab(): void; // was App.tsx's useInput shift+tab handler (mode cycle), moves here
    onCtrlC(): void; // was App.tsx's useInput ctrl+c handler (exit/interrupt), moves here
  }
  export function Footer(props: FooterProps): JSX.Element;
  ```

**Context:** `App.tsx` currently renders `InputBox` + `StatusBar` inline (see `src/ui/App.tsx`'s final `<Box flexDirection="column" ref={liveRegionRef}>` block) and owns a `useInput` hook for escape/shift-tab/ctrl-c handling. This task moves both components and the `useInput` hook into a new standalone `Footer` component — Task 4 will render `Footer` through its own Ink instance, but this task only does the extraction; `Footer` is not yet wired to a second `render()` call, so temporarily render it inside `App.tsx`'s existing tree (same visual output as before) so the app stays runnable and testable at each commit. Task 4 removes it from `App.tsx`'s tree entirely once the dual-instance wiring lands.

The filler mechanism (`staticRows`, `fillerHeight`, `resizeSafeFillerHeight`, `liveRegionFloor`, and the `dynamicRows`/`measureElement`/`justResizedRef`/`termSize`-driven filler `<Box>` in `App.tsx`) is superseded by the real scroll margin from Task 2 and is dead code once Task 4 lands — but removing it here, before Task 4's dual-instance wiring exists, would leave `App.tsx` momentarily without either a filler or a real margin. Remove it in this task anyway, since `Footer` is being extracted out of the measured live region regardless (the filler's row-budget math was built around `InputBox`+`StatusBar` living inside `App.tsx`'s own measured live region, which is no longer true once `Footer` is a separate component) — accept a temporary regression (footer not bottom-anchored) for the span of this one task; Task 4 fixes it via the real margin.

- [ ] **Step 1: Read `App.tsx` fully** (`src/ui/App.tsx`) to identify every piece of state/logic that must move to `Footer` vs. stay in `App`:
  - Moves to `Footer`: the `InputBox` and `StatusBar` JSX, the `useInput` hook (escape/shift-tab/ctrl-c), `menuRows`/`inputRows` state (now purely internal to `Footer`, reported via the new single `onRowsChange` instead of two separate callbacks — StatusBar is always exactly 1 row, so `onRowsChange(rows)` where `rows = inputRows + 1`).
  - Stays in `App`: transcript, `phase`/`streamText`/`activeTool` state (but `phase`/`mode` values are still needed by `Footer` as props — pass down), overlays, `patchLive`, session management, `ctx` (`CommandContext`), `sendUserMessage`/`handleSubmit` (still called from `Footer`'s `onSubmit`, so keep in `App` and pass down as a prop), permission decision logic.
  - Removed entirely: `liveRegionRef`, `dynamicRows`, `measureElement` effect, `justResizedRef`, the resize listener's `justResizedRef.current = true` line (keep the rest of the resize listener — `termSize` is still needed for the stream-tail cap), `transcriptRows`/`liveFloor`/`filler` computation, the filler `<Box>` JSX, and the `bottomFill.ts` imports feeding them (`staticRows`, `resizeSafeFillerHeight`, `liveRegionFloor`, `textRows` — check whether `textRows` is still needed for the stream-tail row math elsewhere in `App.tsx` before removing its import; if the only remaining use was inside the deleted `streamRowsFloor` calculation, remove the import too).

- [ ] **Step 2: Update `bottomFill.ts`** — remove `staticRows`, `fillerHeight`, `resizeSafeFillerHeight`, `liveRegionFloor` and the `LiveRegionState` interface (and their doc comments). Keep `itemRows`/`textRows`/`wrappedRows`/`inputBoxRows` — `itemRows`/`textRows` are unused after this removal *unless* something else in `App.tsx` still needs row-wrap math (verify by grepping `src/ui/App.tsx` and `src/ui/InputBox.tsx` for `textRows`/`itemRows` after Step 1's edits — `InputBox.tsx` calls `inputBoxRows`, which itself calls `textRows` internally, so `textRows` must stay as a non-exported... no, it's already exported and used by `inputBoxRows` in the same file, so keep it exported regardless). `itemRows` becomes unused if nothing outside `bottomFill.ts` calls it (the old `staticRows` was its only caller) — remove `itemRows` and its `DisplayItem`/`renderMarkdown` imports if so; verify with a grep, don't assume.

- [ ] **Step 3: Update `tests/bottom-fill.test.ts`** — remove the `describe` blocks for `staticRows`, `fillerHeight`, `resizeSafeFillerHeight`, `liveRegionFloor`, and (if removed in Step 2) `itemRows`. Keep the `inputBoxRows`/`textRows`/`wrappedRows` tests.

- [ ] **Step 4: Create `src/ui/Footer.tsx`**

```tsx
import React from "react";
import { Box, useInput } from "ink";
import type { PermissionMode } from "../agent/session.js";
import type { History } from "../agent/history.js";
import type { CompletionContext } from "../commands/completion.js";
import { InputBox } from "./InputBox.js";
import { StatusBar } from "./StatusBar.js";

export interface FooterProps {
  completionCtx: CompletionContext;
  onSubmit(text: string): void;
  disabled: boolean;
  history: History;
  columns: number;
  // Total footer height: InputBox's exact reported rows (border + wrapped
  // value + suggestion menu, see InputBox's onInputRowsChange/onMenuRowsChange)
  // plus StatusBar's fixed 1 row. Reported same-render-batch, same mechanism
  // InputBox already uses — see src/ui/bottomFill.ts's inputBoxRows doc comment.
  onRowsChange(rows: number): void;
  provider: string;
  model?: string;
  servedModel?: string;
  mode: PermissionMode;
  cwd: string;
  costUsd: number;
  gitBranch?: string;
  gitDirty?: boolean;
  tokens: number;
  contextPct?: number;
  elapsedMs: number;
  onEscape(): void;
  onShiftTab(): void;
  onCtrlC(): void;
}

export function Footer(props: FooterProps) {
  const [inputRows, setInputRows] = React.useState(3);
  const [menuRows, setMenuRows] = React.useState(0);

  React.useEffect(() => {
    props.onRowsChange(inputRows + menuRows + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputRows, menuRows]);

  useInput((input, key) => {
    if (key.escape) props.onEscape();
    if (key.tab && key.shift) props.onShiftTab();
    if (key.ctrl && input === "c") props.onCtrlC();
  });

  return (
    <Box flexDirection="column">
      <InputBox
        completionCtx={props.completionCtx}
        onSubmit={props.onSubmit}
        disabled={props.disabled}
        history={props.history}
        columns={props.columns}
        onMenuRowsChange={rows => setMenuRows(prev => (prev === rows ? prev : rows))}
        onInputRowsChange={rows => setInputRows(prev => (prev === rows ? prev : rows))}
      />
      <StatusBar
        provider={props.provider} model={props.model} servedModel={props.servedModel} mode={props.mode}
        cwd={props.cwd} costUsd={props.costUsd} gitBranch={props.gitBranch} gitDirty={props.gitDirty}
        tokens={props.tokens} contextPct={props.contextPct} elapsedMs={props.elapsedMs}
      />
    </Box>
  );
}
```

Note: `onRowsChange` is called from a `useEffect` here (not same-render-batch)
because it depends on the COMBINATION of `inputRows` and `menuRows`, both of
which are themselves already reported same-batch from `InputBox` into this
component's own state — the effect fires on the next tick after those land,
which is fine for Task 4's margin sizing (a one-tick-late margin resize is a
cosmetic, not a correctness, concern here, unlike the transcript-overflow
problem the old filler mechanism guarded against: `Footer`'s own Ink instance
still renders its true content immediately regardless of when the margin
catches up — worst case for one frame is the footer's content overlapping the
scroll region by a row or two, not scrollback erasure, since the footer
instance's own `stdout.rows` in Task 2 is set from `footerRows`, independent
of this effect's timing).

- [ ] **Step 5: Wire `Footer` into `App.tsx` temporarily** (same visual position as before, no dual-instance yet). Replace the removed `InputBox`/`StatusBar` JSX and `useInput` hook in `App.tsx`'s return statement with:

```tsx
<Footer
  completionCtx={completionCtx}
  onSubmit={handleSubmit}
  disabled={phase === "streaming"}
  history={historyRef.current}
  columns={termSize.columns}
  onRowsChange={() => { /* Task 4 wires this to setFooterRows */ }}
  provider={providerName} model={model} servedModel={servedModel} mode={mode} cwd={props.cwd} costUsd={cost}
  gitBranch={git.branch} gitDirty={git.dirty}
  tokens={tokens} contextPct={contextPct} elapsedMs={elapsedMs}
  onEscape={() => { if (phase === "streaming") void sessionRef.current?.interrupt(); }}
  onShiftTab={() => {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
    ctx.setPermissionMode(next).catch(err => {
      setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
    });
  }}
  onCtrlC={() => {
    const now = Date.now();
    if (now - lastCtrlCRef.current < 2000) ctx.exit();
    else { lastCtrlCRef.current = now; void sessionRef.current?.interrupt(); notice("Press Ctrl+C again to exit."); }
  }}
/>
```

placed where `InputBox`/`StatusBar` used to render — only when
`!showResumePicker && !showProjectPicker && phase !== "permission"` (same
condition as before; the previous `disabled && <Text>... working ...</Text>`
hint line is already handled inside `InputBox` itself via its own `disabled`
prop, unaffected by this move).

- [ ] **Step 6: Write/adjust tests.** Create `tests/footer.test.tsx` following the existing `ink-testing-library` pattern used in `tests/app.test.tsx` (see that file's `makeApp()`/`fakeClient()` helpers for the general shape, though `Footer` needs none of the agent/session mocking — a minimal harness rendering `<Footer />` directly with stub props is sufficient). Cover: `onRowsChange` fires with `4` (3 baseline input rows + 0 menu + 1 status) on initial mount; `onEscape`/`onShiftTab`/`onCtrlC` fire on the corresponding key events (use `ink-testing-library`'s `stdin.write` the same way `tests/inputBox.test.tsx` already does — read that file for the exact pattern before writing new tests). Update `tests/app.test.tsx` for the now-removed filler assertions (the "bottom-anchored footer" `describe` block from the prior feature — remove it; bottom-anchoring is no longer `App.tsx`'s responsibility) and confirm the rest of the suite (submit flow, permission flow, etc.) still passes with `Footer` inline instead of raw `InputBox`/`StatusBar`.

- [ ] **Step 7: Run the full relevant test set**

Run: `npx vitest run tests/footer.test.tsx tests/app.test.tsx tests/bottom-fill.test.ts tests/inputBox.test.tsx`
Expected: all PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/ui/Footer.tsx src/ui/App.tsx src/ui/bottomFill.ts tests/footer.test.tsx tests/app.test.tsx tests/bottom-fill.test.ts
git commit -m "refactor(ui): extract Footer (InputBox+StatusBar) from App, drop filler mechanism"
```

---

### Task 4: Dual-instance wiring in `cli.tsx`

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/ui/App.tsx` (remove `Footer` from its own tree — it now renders in a separate instance)
- Test: `tests/cli.test.ts` (new — the coordinator logic is extractable and testable; see Step 1)

**Interfaces:**
- Consumes from Task 2: `createRegions`. Consumes from Task 3: `Footer`, `FooterProps`.
- `App`'s props gain nothing new for rendering, but `App` needs a way to hand `Footer`'s required data (session/provider/cost/etc. state) to `cli.tsx`'s `Root`, since `Footer` now renders as a sibling instance, not a child of `App`. This requires lifting the state `Footer` needs (`providerName`, `model`, `servedModel`, `mode`, `cost`, `git`, `tokens`, `contextPct`, `elapsedMs`, `phase`, plus the callbacks `handleSubmit`/interrupt/mode-cycle/exit) out of `App` into `Root`, OR — simpler and smaller-diff — have `App` accept an `onFooterStateChange` callback prop that it calls (via a `useEffect`, same pattern as `Footer`'s own `onRowsChange`) whenever any of that state changes, so `Root` can hold a mirror copy to pass into `Footer`. Choose the callback-mirror approach: it keeps `App`'s internal state ownership unchanged (smaller diff, lower risk) at the cost of one extra indirection.

**Context:** This is the task where the feature becomes real: `cli.tsx` currently does one `render(<Root />)` call. It now creates `Regions` via `createRegions`, renders `App` into `contentStdout`, renders `Footer` into `footerStdout`, and bridges state between them via `Root`.

- [ ] **Step 1: Design the state bridge.** In `src/ui/App.tsx`, add a prop `onFooterProps: (props: Omit<FooterProps, "onRowsChange">) => void` (import `FooterProps` from `./Footer.js`). Add a `useEffect` in `App` that calls `props.onFooterProps({...})` with the current values of every field `Footer` needs, dependent on every value that changes (`providerName, model, servedModel, mode, cost, git.branch, git.dirty, tokens, contextPct, elapsedMs, phase`, plus the four stable callback references — `handleSubmit`, `historyRef.current`, `completionCtx`, and the three key-handler closures, all already defined in `App`). Remove `Footer` from `App`'s JSX entirely (delete the block added in Task 3 Step 5) — `App`'s return statement goes back to ending at the overlays, no footer/filler rendering at all.

- [ ] **Step 2: Rewrite `src/cli.tsx`**

```tsx
#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./ui/App.js";
import { Footer, type FooterProps } from "./ui/Footer.js";
import { createRegions } from "./ui/terminalRegions.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string" },
    version: { type: "boolean", default: false }
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

const INITIAL_FOOTER_ROWS = 4; // 3-row empty InputBox + 1-row StatusBar baseline.
const regions = createRegions(process.stdout as NodeJS.WriteStream, INITIAL_FOOTER_ROWS);
process.on("exit", regions.teardown);
process.on("SIGINT", () => { regions.teardown(); process.exit(0); });

function Root() {
  const [cwd, setCwd] = React.useState(initialCwd);
  const [prevCwd, setPrevCwd] = React.useState<string | undefined>(undefined);
  const [footerProps, setFooterProps] = React.useState<Omit<FooterProps, "onRowsChange"> | undefined>(undefined);
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
    <App
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
      onFooterProps={setFooterProps}
    />
  );
}

function FooterRoot() {
  const [footerProps, setFooterProps] = React.useState<Omit<FooterProps, "onRowsChange"> | undefined>(undefined);
  // Populated by the same Root-level bridge — see Step 3 below for how
  // footerProps actually crosses from Root's instance to this one; a
  // React useState here cannot receive props from a sibling Ink instance's
  // tree directly, since they are two separate reconciler roots.
  if (!footerProps) return null;
  return (
    <Footer
      {...footerProps}
      onRowsChange={rows => regions.setFooterRows(rows)}
    />
  );
}

render(<Root />, { stdout: regions.contentStdout });
render(<FooterRoot />, { stdout: regions.footerStdout, stdin: process.stdin });
```

**Known gap in the sketch above, to resolve during implementation:** `Root`
and `FooterRoot` are two separate reconciler trees — `Root`'s `setFooterProps`
state cannot be read by `FooterRoot` via React state/context, since they
don't share a tree. Bridge them with a plain module-level event emitter (or
a tiny pub/sub object) created above both components: `Root`'s effect calls
`footerBus.emit(props)`, `FooterRoot` subscribes via
`useEffect(() => footerBus.on(setFooterProps), [])`. Write this small bus
inline in `cli.tsx` (a `Set<(p) => void>` of listeners plus `emit`/`on`
functions is sufficient — do not pull in an external event-emitter
dependency for this). Also resolve which Ink instance should own
`stdin`/raw-mode: only `FooterRoot`'s `render()` call should pass
`stdin: process.stdin` (as sketched above) since `Footer` owns the
`useInput` hook and `InputBox`'s own `useInput` — `Root`'s `render()` call
should NOT receive `stdin` (check Ink's `RenderOptions` type for whether
omitting `stdin` is valid / what it defaults to, since `Root`'s tree has no
`useInput` calls of its own after Task 3's extraction and must not
contend for raw-mode ownership).

- [ ] **Step 3: Implement the module-level bridge and finalize `cli.tsx`.** Add this bus above `Root`/`FooterRoot` in `src/cli.tsx`:

```ts
function createFooterPropsBus() {
  const listeners = new Set<(props: Omit<FooterProps, "onRowsChange">) => void>();
  return {
    emit(props: Omit<FooterProps, "onRowsChange">) { for (const l of listeners) l(props); },
    on(listener: (props: Omit<FooterProps, "onRowsChange">) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
const footerPropsBus = createFooterPropsBus();
```

Wire `Root`: replace its `setFooterProps` state (unused there — delete it)
with calling `footerPropsBus.emit(props)` from the `onFooterProps` prop
passed to `App`. Wire `FooterRoot`:
`React.useEffect(() => footerPropsBus.on(setFooterProps), [])`.

Before finalizing the two `render()` calls, read Ink's `RenderOptions` type
(`node_modules/ink/build/render.d.ts` or wherever the installed package
declares it) to confirm: (a) whether omitting `stdin` from `Root`'s
`render()` call is valid and what it defaults to, and (b) that passing
`process.stdin` explicitly to `FooterRoot`'s `render()` call is the correct
way to give only that instance raw-mode/`useInput` ownership. Adjust the
sketch in Step 2 if the actual type signature requires something different
(e.g. `Root`'s call may need an explicit `exitOnCtrlC: false` or similar —
confirm from the type declarations and existing usage in `src/cli.tsx`
before this change, not from assumption).

- [ ] **Step 4: Manual real-terminal verification.** Run `npm run dev` (or the project's existing dev entry point — check `package.json` scripts) in a real terminal. Confirm: app starts, input box + status bar render at the bottom, typing/submitting works, provider/model/cost/git status display correctly. This is not automatable under `ink-testing-library` (no real terminal/margin), so this step is a manual gate, same as prior features' real-TTY verification steps.

- [ ] **Step 5: Manual scroll verification (the feature's actual purpose).** In the same real terminal session, generate enough transcript output to exceed one screen (e.g. a few exchanges), then scroll the terminal viewport up with the mouse wheel. Confirm: only the transcript moves; the input box and status bar remain visually fixed at the bottom rows, uncorrupted, matching Claude Code's behavior. Then resize the terminal window and confirm the margin/footer adapt without corruption.

- [ ] **Step 6: Write `tests/cli.test.ts`** covering only the module-level event bus in isolation (extract it as a small named function/object if not already trivially testable inline — e.g. `createFooterPropsBus()`), asserting: a listener registered via `on` receives values passed to `emit`; multiple listeners all receive the same emitted value; `off`/unsubscribe (if the effect cleanup needs it) stops delivery. The rest of `cli.tsx` (process wiring, `render()` calls) is integration-level and covered by Step 4/5's manual verification, not unit tests.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all pass except the pre-existing, unrelated `tests/skills.test.ts` environmental failures (verify this is still exactly 7 failures, same as before this branch — if the count changed, investigate before proceeding).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/cli.tsx src/ui/App.tsx tests/cli.test.ts
git commit -m "feat(ui): wire dual Ink instances for a scroll-margin-pinned footer"
```
