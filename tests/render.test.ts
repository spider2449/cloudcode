import { describe, it, expect } from "vitest";
import { InlineRenderer, type BottomState } from "../src/ui/term/render.js";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";
import { setColorDepth, detectColorDepth } from "../src/ui/term/ansi.js";

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
    thinkingText: "",
    activeTool: undefined,
    compactPct: undefined,
    queuedRows: [],
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
    // Footer = workInd(1) + tailForHeight capped to streamTailCap(16) + border(2) + content(1) + status(1) = 21 lines,
    // so scrollBottom = rows - footer = 24 - 21 = 3.
    expect(out).toContain(`\x1b[1;3r`);
  });

  it("growing footer height with no content on screen redraws without scrolling (no blank-line burst)", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // First frame: footer is 4 lines, scrollBottom = 20.
    r.frame(buf, baseBottom(), theme, size);
    // Second frame: streaming adds a work-indicator line, footer becomes 5 lines, scrollBottom = 19.
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // No content was ever committed, so nothing needs to be scrolled into
    // scrollback: the old evacuate burst (`\x1b[20;1H\r\n`) must not appear.
    expect(second).not.toContain(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    expect(second).toContain(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
  });

  it("growing footer height with more on-screen content than the new region holds reprints it through the new region so the excess reaches scrollback", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // Commit enough rows to fill the entire first scroll region (20 rows),
    // so all of it is "on screen" and none of it can fit once the region
    // shrinks by 1 row on the second frame.
    for (let i = 0; i < SCROLL_BOTTOM; i++) buf.append({ kind: "notice", text: `row ${i}` });
    r.frame(buf, baseBottom(), theme, size);
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // More content is on screen (19 usable rows) than the new region can hold
    // (18 usable rows): the new region must be set first, then all cached
    // on-screen rows re-printed through it so the excess scrolls into native
    // scrollback naturally, with no blank filler.
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
    expect(newRegionIdx).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < SCROLL_BOTTOM; i++) {
      expect(second.indexOf(`row ${i}`)).toBeGreaterThan(newRegionIdx);
    }
  });

  it("growing footer height with partial on-screen content (fits new region) redraws it at the new bottom-anchored position, not via scrolling", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "ONLY_ROW" });
    r.frame(buf, baseBottom(), theme, size); // commits "ONLY_ROW", scrollBottom = 20
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // scrollBottom = 19
    // 1 row of real content fits easily inside a 19-row region: redrawn
    // directly, no scroll burst, and it must still be present on screen.
    expect(second).not.toContain(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    expect(second).toContain("ONLY_ROW");
  });

  it("fits-redraw anchors content at scrollBottom-1, leaving the true bottom row blank", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "ONLY_ROW" });
    r.frame(buf, baseBottom(), theme, size); // commits "ONLY_ROW", scrollBottom = 20
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // scrollBottom = 19
    // Correct anchor is row 18 (scrollBottom - onScreen = 19 - 1), not row 19
    // (the buggy scrollBottom - onScreen + 1), which would leave no blank row
    // at the new bottom margin and violate the commit invariant.
    const correctAnchor = `\x1b[${SCROLL_BOTTOM - 2};1H`; // row 18
    const wrongAnchor = `\x1b[${SCROLL_BOTTOM - 1};1H`; // row 19
    expect(second).toContain(correctAnchor);
    const anchorIdx = second.indexOf(correctAnchor);
    const markerIdx = second.indexOf("ONLY_ROW");
    expect(markerIdx).toBeGreaterThan(anchorIdx);
    // The wrong anchor must not immediately precede the row's own text.
    const wrongIdx = second.lastIndexOf(wrongAnchor, markerIdx);
    // wrongAnchor may legitimately appear elsewhere (e.g. unrelated cursor
    // moves), but it must not be the position directly feeding ONLY_ROW.
    if (wrongIdx >= 0) {
      expect(second.slice(wrongIdx + wrongAnchor.length, markerIdx)).not.toBe("");
    }
  });

  it("a row relocated by a fits-redraw survives a follow-up commit at the same footer height", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "ROW_A" });
    r.frame(buf, baseBottom(), theme, size); // commits "ROW_A", scrollBottom = 20
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // fits-redraw, scrollBottom = 19
    buf.append({ kind: "notice", text: "ROW_B" });
    const third = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // same footer height, normal commit
    // ROW_A must have been redrawn at row 18 (blank row 19 reserved), so the
    // normal commit path (which writes at cursorTo(scrollBottom=19,1) then
    // \r\n) lands in the blank row and does not overwrite row 18 where ROW_A
    // sits. Under the buggy +1 anchor, ROW_A would have been placed at row
    // 19 itself, and the third frame's commit would silently overwrite it.
    expect(second).toContain("ROW_A");
    expect(third).toContain("ROW_B");
    // ROW_A is never re-emitted (committed rows are emitted exactly once),
    // so its survival is only observable via the anchor row it was placed
    // at not being clobbered: confirm the third frame's commit write targets
    // row 19 (scrollBottom), one row below where ROW_A was drawn (row 18).
    expect(third).toContain(`\x1b[${SCROLL_BOTTOM - 1};1H`); // row 19
    expect(third.indexOf("ROW_B")).toBeGreaterThan(third.indexOf(`\x1b[${SCROLL_BOTTOM - 1};1H`));
  });

  it("sudden large footer growth (first streaming chunk) does not scroll blank filler rows into scrollback", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // Commit 5 rows while idle: scrollBottom = 20, content sits bottom-anchored
    // at rows 15..19 with rows 1..14 blank above it.
    for (let i = 0; i < 5; i++) buf.append({ kind: "notice", text: `row ${i}` });
    r.frame(buf, baseBottom(), theme, size);
    // A large first streaming chunk arrives between frames: the footer jumps
    // from 4 rows to 21 in a single frame, scrollBottom collapses 20 -> 3.
    // onScreen (5) no longer fits the new region (2 usable rows), but a raw
    // region scroll of (20 - 3) = 17 rows would push the 14 blank rows above
    // the content into native scrollback as a permanent visible gap.
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const second = r.frame(buf, baseBottom({ streaming: true, streamingText: longText }), theme, size);
    // The blank-burst signature (cursor to old scrollBottom + newline run)
    // must not appear.
    expect(second).not.toContain(`\x1b[${SCROLL_BOTTOM};1H\r\n\r\n`);
    // Instead the cached content rows are re-printed through the new region
    // so only real content (never blank filler) reaches scrollback.
    for (let i = 0; i < 5; i++) expect(second).toContain(`row ${i}`);
    expect(second).toContain(`\x1b[1;1H\x1b[0J`);
    expect(second).toContain(`\x1b[1;3r`);
  });

  it("boundary: onScreen exactly filling the new region reprints content through the region, never blank filler", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // Commit exactly (SCROLL_BOTTOM - 1) rows: under the corrected invariant,
    // onScreen = min(printedRows, lastScrollBottom - 1) = SCROLL_BOTTOM - 1,
    // and the new scrollBottom after growth is SCROLL_BOTTOM - 1 too, so
    // onScreen == scrollBottom exactly -- zero blank rows would remain if
    // redrawn, so this must fall through to the evacuate branch.
    for (let i = 0; i < SCROLL_BOTTOM - 1; i++) buf.append({ kind: "notice", text: `row ${i}` });
    r.frame(buf, baseBottom(), theme, size); // scrollBottom = 20
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // scrollBottom = 19
    // Reprint-through-region signature: new region set, then the cached rows
    // re-printed after it (one of them scrolls into scrollback naturally).
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
    expect(newRegionIdx).toBeGreaterThanOrEqual(0);
    expect(second.indexOf("row 0")).toBeGreaterThan(newRegionIdx);
  });

  it("shrinking footer height (region growing back) redraws the on-screen content at the new position, not via a stale-footer erase", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // First frame: streaming, footer is 5 lines, scrollBottom = 19.
    r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // Second frame: streaming stops, footer shrinks back to 4 lines, scrollBottom = 20.
    const second = r.frame(buf, baseBottom(), theme, size);
    // With no content on screen, the unified redraw-in-place branch clears
    // the viewport from the top (row 1) rather than only erasing the freed
    // footer rows -- this is what lets it also reposition existing content
    // when there is some (see the "footer shrinking back to idle" test).
    const redrawIdx = second.indexOf(`\x1b[1;1H\x1b[0J`);
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM}r`);
    expect(redrawIdx).toBeGreaterThanOrEqual(0);
    expect(newRegionIdx).toBeGreaterThanOrEqual(0);
  });

  it("footer shrinking back to idle (region growing) repositions existing content adjacent to new commits, not stranded with a gap", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "tool", label: "Bash dir /b" });
    r.frame(buf, baseBottom(), theme, size); // idle, scrollBottom=20, "Bash dir /b" ends at row 19
    r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // shrink to 19
    // Streaming ends: footer shrinks back to idle (4 lines), scrollBottom
    // grows back to 20, and the full response commits in the same frame.
    buf.append({ kind: "assistant", text: "final answer" });
    const third = r.frame(buf, baseBottom(), theme, size);
    // The tool label must be redrawn adjacent to (immediately above) the
    // new content's blank separator, not left behind with erased blank
    // rows in between. Assert both are present and no more than the
    // expected 1 blank separator row (Task 5 spacing) sits between them.
    const toolIdx = third.indexOf("Bash dir /b");
    const answerIdx = third.indexOf("final answer");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeGreaterThan(toolIdx);
    const between = third.slice(toolIdx, answerIdx);
    // No more than 2 CRLFs between them: end of the tool line, and the one
    // intentional blank separator row before the assistant item.
    expect((between.match(/\r\n/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("streaming end with transcript already in scrollback triggers a full clear + recommit, not a blank-padded redraw", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // 10 rows committed while idle (scrollBottom = 20, all on screen).
    for (let i = 0; i < 10; i++) buf.append({ kind: "notice", text: `early ${i}` });
    r.frame(buf, baseBottom(), theme, size);
    // A large streaming preview collapses the region to scrollBottom = 3:
    // 8 of the 10 rows scroll into native scrollback, 2 stay on screen.
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    r.frame(buf, baseBottom({ streaming: true, streamingText: longText }), theme, size);
    // Streaming ends and the full answer commits. A bottom-anchored redraw
    // here would leave ~17 blank rows above the 2 redrawn rows, and the
    // answer's commit would scroll those blanks into scrollback as a
    // permanent gap between the early rows and the answer. Instead the
    // renderer must clear screen + scrollback and recommit the whole
    // transcript, exactly like the resize path the user confirmed works.
    buf.append({ kind: "assistant", text: "the answer" });
    const third = r.frame(buf, baseBottom(), theme, size);
    expect(third).toContain("\x1b[2J\x1b[3J");
    // The whole transcript is re-emitted contiguously.
    for (let i = 0; i < 10; i++) expect(third).toContain(`early ${i}`);
    expect(third).toContain("the answer");
  });

  it("streaming end with the whole transcript still on screen keeps the cheap bottom-anchored redraw (no scrollback wipe)", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "ONLY_ROW" });
    r.frame(buf, baseBottom(), theme, size); // scrollBottom = 20, 1 row on screen
    r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // scrollBottom = 19
    const third = r.frame(buf, baseBottom(), theme, size); // back to 20
    // Nothing from this session is in scrollback, so wiping the user's
    // scrollback (3J) would be gratuitous; the redraw-in-place branch stays.
    expect(third).not.toContain("\x1b[3J");
    expect(third).toContain(`\x1b[1;1H\x1b[0J`);
  });

  it("a rows-only resize (window dragged taller, columns unchanged) repositions on-screen content instead of leaving it stranded", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "STAYS_VISIBLE" });
    r.frame(buf, baseBottom(), theme, size); // rows=24, columns=80, scrollBottom=20; content ends at row 19
    // Window dragged taller: rows 24 -> 30, columns unchanged. This must be
    // treated the same as any other footer-relative scrollBottom change,
    // not skipped just because it came from a real resize event.
    const resized = r.frame(buf, baseBottom(), theme, { rows: 30, columns: 80 });
    // New scrollBottom = 30 - 4 = 26. Content must be redrawn (repositioned),
    // not left at its old row with the region boundary just moved past it.
    expect(resized).toContain("STAYS_VISIBLE");
    expect(resized).toContain(`\x1b[1;1H\x1b[0J`); // the redraw-in-place signature
    expect(resized).toContain(`\x1b[1;26r`); // new region
  });

  it("repeated rows-only resize events in quick succession (a drag) do not strand or duplicate content", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "SOLE_ROW" });
    r.frame(buf, baseBottom(), theme, size); // rows=24
    let last = "";
    for (const rows of [26, 28, 30, 32, 30, 28, 26, 24]) {
      last = r.frame(buf, baseBottom(), theme, { rows, columns: 80 });
    }
    // The final frame must still show the content -- it must survive a
    // whole resize storm, not just a single resize step.
    expect(last).toContain("SOLE_ROW");
    // It must appear exactly once in the final frame's output (not
    // duplicated by a stale earlier redraw plus a fresh one).
    expect((last.match(/SOLE_ROW/g) ?? []).length).toBe(1);
  });

  it("a columns change drops the stale row cache instead of redrawing content wrapped for the old width", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "WIDE_CONTENT" });
    r.frame(buf, baseBottom(), theme, size); // columns=80
    // Columns change: cached rows were wrapped for width 80 and are invalid
    // at width 120. The redraw-in-place branch must NOT fire for this
    // frame (nativeApp.ts's debounced full recommit handles the correct
    // re-wrap shortly after); this frame should not emit the redraw
    // signature at all.
    const resized = r.frame(buf, baseBottom(), theme, { rows: size.rows, columns: 120 });
    expect(resized).not.toContain(`\x1b[1;1H\x1b[0J`);
    expect(resized).toContain(`\x1b[1;${SCROLL_BOTTOM}r`); // region still gets set
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

  it("hard-wraps over-width streaming/thinking lines so no footer row exceeds the terminal width", () => {
    // Legacy conhost ignores DECAWM-off (CSI ?7l): an over-width row wraps at
    // the bottom of the screen, scrolls the viewport, and strands stale copies
    // of the footer in the transcript. Footer rows must therefore never be
    // wider than the terminal.
    const r = new InlineRenderer();
    const buf = new Buffer();
    const longLine = "Q".repeat(200); // 200 > 80 columns
    const out = r.frame(buf, baseBottom({ streaming: true, streamingText: longLine, thinkingText: longLine }), theme, size);
    const footer = out.slice(out.lastIndexOf("\x1b[0J"));
    for (const row of footer.split("\r\n")) {
      const visible = row.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      expect(visible.length).toBeLessThanOrEqual(size.columns);
    }
    // The wrapped text is still fully present, split across rows, not clipped away.
    const visibleAll = footer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect((visibleAll.match(/Q/g) ?? []).length).toBe(400);
  });

  it("renders thinkingText dim above the stream text", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom({ thinkingText: "pondering...", streamingText: "" }), theme, size);
    expect(out).toContain("\x1b[2m");
    expect(out).toContain("pondering...");
    expect(out).toContain("\x1b[22m");
  });

  it("prefixes the thinking preview with a hollow circle in the theme's thinking color (magenta in the dark theme)", () => {
    const previousDepth = detectColorDepth();
    setColorDepth("16");
    try {
      const r = new InlineRenderer();
      const buf = new Buffer();
      const out = r.frame(buf, baseBottom({ thinkingText: "pondering...", streamingText: "" }), theme, size);
      expect(out).toContain("○ pondering...");
      expect(out).toContain("\x1b[35m");
    } finally {
      setColorDepth(previousDepth);
    }
  });

  it("renders queuedRows above the input box rows", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(
      buf,
      baseBottom({ queuedRows: ["⧉ queued: fix tests"] }),
      theme,
      size
    );
    expect(out).toContain("⧉ queued: fix tests");
    // Queued rows sit above the input box's first border row ("╭─╮" in
    // emptyInputRender), i.e. earlier in the footer paint.
    expect(out.indexOf("⧉ queued: fix tests")).toBeLessThan(out.indexOf("╭─╮"));
  });
});
