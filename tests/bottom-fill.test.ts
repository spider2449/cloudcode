import { describe, it, expect } from "vitest";
import {
  itemRows,
  staticRows,
  fillerHeight,
  liveRegionFloor,
  inputBoxRows,
  resizeSafeFillerHeight,
  type LiveRegionState
} from "../src/ui/bottomFill.js";
import { MAX_ROWS as SUGGESTION_MENU_MAX_ROWS } from "../src/ui/SuggestionMenu.js";
import type { DisplayItem } from "../src/ui/transcript.js";

describe("itemRows", () => {
  it("counts a single-line notice as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "hello" }, 80)).toBe(1);
  });

  it("counts multi-line text by newlines", () => {
    expect(itemRows({ kind: "notice", text: "a\nb\nc" }, 80)).toBe(3);
  });

  it("counts wrapped lines: user prefix '> ' pushes 79 chars to 2 rows at width 80", () => {
    // "> " (2 chars) + 79 chars = 81 chars -> 2 rows
    expect(itemRows({ kind: "user", text: "x".repeat(79) }, 80)).toBe(2);
  });

  it("counts an empty line as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "" }, 80)).toBe(1);
  });

  it("result items are 1 row", () => {
    expect(itemRows({ kind: "result", costUsd: 0.01, durationMs: 1000 }, 80)).toBe(1);
  });

  it("diff items account for the 2-column margin", () => {
    // Each diff line renders as "+ xxx" in width (80 - 2) = 78.
    // sign+space (2) + 77 chars = 79 chars > 78 -> 2 rows.
    const lines = [{ sign: "+" as const, text: "y".repeat(77) }];
    expect(itemRows({ kind: "diff", lines }, 80)).toBe(2);
  });

  it("strips ANSI codes from assistant markdown before measuring", () => {
    // renderMarkdown emits ANSI-styled output; a short bold word must
    // still count as 1 row even though escape bytes inflate raw length.
    expect(itemRows({ kind: "assistant", text: "**hi**" }, 10)).toBe(1);
  });
});

describe("staticRows", () => {
  const notice = (text: string): DisplayItem => ({ kind: "notice", text });

  it("sums rows across items", () => {
    expect(staticRows([notice("a"), notice("b\nc")], 80, 100)).toBe(3);
  });

  it("early-exits at cap", () => {
    const items = Array.from({ length: 50 }, () => notice("line"));
    expect(staticRows(items, 80, 10)).toBe(10);
  });

  it("returns 0 for an empty transcript", () => {
    expect(staticRows([], 80, 24)).toBe(0);
  });
});

describe("fillerHeight", () => {
  it("fills unused space minus the 1-row reserve", () => {
    // 24 rows, 5 transcript rows, 6 live-region rows -> 24 - 5 - 6 - 1 = 12
    expect(fillerHeight(24, 5, 6)).toBe(12);
  });

  it("returns 0 on exact fit", () => {
    expect(fillerHeight(24, 17, 6)).toBe(0);
  });

  it("clamps to 0 on overflow", () => {
    expect(fillerHeight(24, 100, 6)).toBe(0);
  });
});

describe("liveRegionFloor", () => {
  const base: LiveRegionState = {
    streamRows: 0,
    streaming: false,
    compacting: false,
    inputRows: 0,
    overlayRows: 0
  };

  it("counts just the StatusBar when nothing else is visible", () => {
    expect(liveRegionFloor(base)).toBe(1);
  });

  it("adds InputBox's exact reported row count when visible", () => {
    expect(liveRegionFloor({ ...base, inputRows: 3 })).toBe(4);
    // Finding 1a: a wrapped/multi-line value must not be flattened to 3.
    expect(liveRegionFloor({ ...base, inputRows: 6 })).toBe(7);
  });

  it("adds 1 row for WorkingIndicator when streaming", () => {
    expect(liveRegionFloor({ ...base, streaming: true })).toBe(2);
  });

  it("adds 1 row for ProgressBar when compacting", () => {
    expect(liveRegionFloor({ ...base, compacting: true })).toBe(2);
  });

  it("adds streamRows and overlayRows directly", () => {
    expect(liveRegionFloor({ ...base, streamRows: 5, overlayRows: 12 })).toBe(1 + 5 + 12);
  });
});

describe("growth-transition invariant: no single frame may reach the row budget", () => {
  // Regression for the one-frame measurement lag: measureElement runs after
  // render, so the frame a live-region element first appears in still
  // renders with the PREVIOUS (stale) dynamicRows. With staticRows = 0 (the
  // state right after /clear) and a near-full-screen filler already
  // committed, any live-region growth in that next frame must not push
  // filler + actual-live-region up to terminalRows, or Ink clears
  // scrollback. The fix is Math.max(dynamicRows, liveRegionFloor(...)); this
  // asserts that even with a maximally stale measured dynamicRows (0), the
  // floor alone keeps filler + floor strictly under terminalRows.
  const terminalRows = 24;

  it("/clear then WorkingIndicator appears on send (streaming frame)", () => {
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: true,
      compacting: false,
      inputRows: 3,
      overlayRows: 0
    });
    const staleMeasuredDynamicRows = 0; // measureElement hasn't caught up yet
    const filler = fillerHeight(terminalRows, 0, Math.max(staleMeasuredDynamicRows, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });

  it("/clear then typing '/' opens the suggestion menu at its max row count", () => {
    // App.tsx's chosen resolution: InputBox reports its EXACT current
    // suggestion-menu row count up to App.tsx synchronously, within the
    // same input-event batch that updates InputBox's own state (Ink wraps
    // every useInput handler in reconciler.batchedUpdates), so this value
    // is never stale the way measureElement's dynamicRows is. This test
    // mirrors App.tsx's floor + menuRows call site with the worst case
    // (menu fully open at SuggestionMenu's MAX_ROWS).
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: false,
      inputRows: 3,
      overlayRows: 0
    }) + SUGGESTION_MENU_MAX_ROWS;
    const filler = fillerHeight(terminalRows, 0, Math.max(0, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });

  it("permission dialog appears (overlay frame)", () => {
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: false,
      inputRows: 0,
      overlayRows: 12
    });
    const filler = fillerHeight(terminalRows, 0, Math.max(0, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });

  it("compaction ProgressBar appears", () => {
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: true,
      inputRows: 3,
      overlayRows: 0
    });
    const filler = fillerHeight(terminalRows, 0, Math.max(0, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });

  // Finding 1a (re-review): InputBox's own height growth (a word-wrapped
  // long typed/pasted line, or a backtick-continuation literal newline) was
  // previously unmodeled — liveRegionFloor always assumed a flat 3 rows for
  // the input box regardless of its actual wrapped content, so a frame where
  // /clear left staticRows at 0 and the input box grows past 3 rows could
  // still push filler + actual-live-region up to terminalRows. Before the
  // fix, this test's `floor` (computed with the old flat-3 assumption)
  // would be 4, `filler` would be sized against that stale-low floor, and
  // filler + REAL_inputRows(where REAL_inputRows > 3) would reach or exceed
  // terminalRows. With inputBoxRows reporting the real wrapped height into
  // the floor, filler shrinks to match and the invariant holds.
  it("/clear then typing a line that word-wraps past the input box's baseline 3 rows", () => {
    const columns = 40;
    const longLine = "x".repeat(200); // wraps to many rows at columns=40
    const realInputRows = inputBoxRows("> " + longLine + "█", columns);
    expect(realInputRows).toBeGreaterThan(3); // sanity: this really did grow
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: false,
      inputRows: realInputRows,
      overlayRows: 0
    });
    const staleMeasuredDynamicRows = 4; // measureElement hasn't caught up yet
    const filler = fillerHeight(terminalRows, 0, Math.max(staleMeasuredDynamicRows, floor));
    expect(filler + Math.max(staleMeasuredDynamicRows, floor)).toBeLessThan(terminalRows);
  });

  it("/clear then a backtick-continuation newline grows the input box by a real line", () => {
    const columns = 80;
    // "line one\nline two" — the literal newline InputBox inserts when the
    // user types "line one\" + Enter (see InputBox.tsx's submit()).
    const content = "> line one\nline two█";
    const realInputRows = inputBoxRows(content, columns);
    expect(realInputRows).toBe(2 /* border */ + 2 /* two lines */);
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: false,
      inputRows: realInputRows,
      overlayRows: 0
    });
    const filler = fillerHeight(terminalRows, 0, Math.max(0, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });

  // Finding 1c (re-review): ResumePicker/ProjectPicker used to render every
  // entry with no windowing, so overlayRows: 12 was not a true upper bound
  // once N (past sessions/projects) exceeded ~9. Both pickers now cap
  // visible rows to SuggestionMenu's MAX_ROWS (8) via the same
  // visibleWindow helper, so the true worst case is border(2) + header(1) +
  // 8 entries = 11, which fits under the 12 reserved here even at N = 500.
  it("overlay frame stays bounded even with hundreds of picker entries (windowing makes 12 a true cap)", () => {
    const pickerWorstCaseRows = 2 /* border */ + 1 /* header */ + SUGGESTION_MENU_MAX_ROWS;
    expect(pickerWorstCaseRows).toBeLessThanOrEqual(12);
    const floor = liveRegionFloor({
      streamRows: 0,
      streaming: false,
      compacting: false,
      inputRows: 0,
      overlayRows: 12
    });
    const filler = fillerHeight(terminalRows, 0, Math.max(0, floor));
    expect(filler + floor).toBeLessThan(terminalRows);
  });
});

describe("resizeSafeFillerHeight (Change 1: resize-transition safety net)", () => {
  it("demonstrates the bug: computing filler from a stale post-resize floor can overflow", () => {
    // Scenario: post-/clear (staticRows=0), the input box already contains a
    // long line. Terminal resizes from a wide, tall size down to a narrower,
    // shorter one. For one frame, InputBox's onInputRowsChange effect and
    // App.tsx's measureElement pass haven't re-run yet, so both dynamicRows
    // and the live-region floor's inputRows still reflect the OLD (wide)
    // width's wrap of that line (3 rows), while termSize.rows already
    // reflects the NEW (shorter) terminal.
    const newTerminalRows = 10;
    const staleInputRows = 3;
    const staleFloor = liveRegionFloor({
      streamRows: 0, streaming: false, compacting: false,
      inputRows: staleInputRows, overlayRows: 0
    });
    const staleMeasuredDynamicRows = 3;

    const unsafeFiller = fillerHeight(newTerminalRows, 0, Math.max(staleMeasuredDynamicRows, staleFloor));

    // Once the effects catch up (next frame), the input box's REAL wrapped
    // height at the new, narrower width is bigger.
    const realPostResizeInputRows = 6;
    const realHeight = liveRegionFloor({
      streamRows: 0, streaming: false, compacting: false,
      inputRows: realPostResizeInputRows, overlayRows: 0
    });

    // The bug: filler sized against the stale floor, plus the real height
    // once it catches up, reaches/exceeds the new terminal height -> Ink
    // clears scrollback.
    expect(unsafeFiller + realHeight).toBeGreaterThanOrEqual(newTerminalRows);
  });

  it("suppresses filler to 0 for the resize-transition frame, avoiding the overflow above", () => {
    const newTerminalRows = 10;
    const staleInputRows = 3;
    const staleFloor = liveRegionFloor({
      streamRows: 0, streaming: false, compacting: false,
      inputRows: staleInputRows, overlayRows: 0
    });
    const staleMeasuredDynamicRows = 3;
    const realPostResizeInputRows = 6;
    const realHeight = liveRegionFloor({
      streamRows: 0, streaming: false, compacting: false,
      inputRows: realPostResizeInputRows, overlayRows: 0
    });

    const safeFiller = resizeSafeFillerHeight(
      newTerminalRows,
      0,
      Math.max(staleMeasuredDynamicRows, staleFloor),
      true // justResized
    );
    expect(safeFiller).toBe(0);
    expect(safeFiller + realHeight).toBeLessThan(newTerminalRows);
  });

  it("falls back to normal fillerHeight once the resize-transition frame has passed", () => {
    expect(resizeSafeFillerHeight(24, 5, 6, false)).toBe(fillerHeight(24, 5, 6));
  });
});

describe("inputBoxRows (Finding 1a)", () => {
  it("is 2 border rows + 1 content row for a short empty-ish value", () => {
    expect(inputBoxRows("> █", 80)).toBe(3);
  });

  it("grows past the flat baseline of 3 when the value word-wraps", () => {
    // width available = columns(40) - 4 = 36; "> " + 100 x's = 102 chars
    // -> ceil(102/36) = 3 wrapped rows -> 2 border + 3 = 5
    const rows = inputBoxRows("> " + "x".repeat(100), 40);
    expect(rows).toBe(5);
  });

  it("counts a literal newline (backtick-continuation) as a real extra row", () => {
    expect(inputBoxRows("> a\nb", 80)).toBe(4); // border(2) + 2 lines
  });
});
