import { describe, it, expect } from "vitest";
import { InlineRenderer } from "../src/ui/term/render.js";
import { Buffer } from "../src/ui/buffer.js";
import { theme, size, baseBottom } from "./helpers/renderFixtures.js";

describe("InlineRenderer (simple mode, no scroll region)", () => {
  it("never emits a DECSTBM scroll-region sequence", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).not.toMatch(/\x1b\[\d*;\d*r/);
  });

  it("first frame prints transcript rows then the footer with no leading erase", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    buf.append({ kind: "user", text: "hi" });
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out.indexOf("hi")).toBeLessThan(out.indexOf("╭─╮"));
  });

  it("erases exactly the previous footer height before reprinting on the next frame", () => {
    // The cursor is parked on the input row after a frame so the IME can
    // anchor there. Returning to the footer's first row moves up by that
    // input row's zero-based index before erasing.
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    r.frame(buf, baseBottom(), theme, size);
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain("\x1b[2A\r\x1b[0J");
    expect(out.endsWith("\x1b[1A\r\x1b[2C")).toBe(true);
  });

  it("does not creep the footer upward or delete transcript rows across repeated no-op frames", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "KEEP_ME" });
    r.frame(buf, baseBottom(), theme, size);
    let out = "";
    for (let i = 0; i < 5; i++) out = r.frame(buf, baseBottom(), theme, size);
    // Every steady-state frame erases the exact same footer height and
    // reprints it; none of them may touch rows above the footer, so the
    // once-committed transcript row is never re-erased.
    const eraseCount = (out.match(/\x1b\[0J/g) ?? []).length;
    expect(eraseCount).toBe(1);
    expect(out).not.toContain("KEEP_ME");
  });

  it("pads a shrinking footer instead of letting it creep upward when no new content displaces it", () => {
    // thinkingText lives in the footer; when it disappears with nothing new
    // committed, the footer must not visibly move up -- it should stay
    // anchored at the same erase-distance from the prior frame, absorbing
    // the shrink as invisible padding instead.
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    r.frame(buf, baseBottom({ streaming: true, thinkingText: "pondering...\nstill going" }), theme, size);
    const cursorUpMatch = (s: string) => /\x1b\[(\d+)A/.exec(s)?.[1];
    const second = r.frame(buf, baseBottom({ streaming: true, streamingText: "hi" }), theme, size);
    const third = r.frame(buf, baseBottom({ streaming: true, streamingText: "hi there" }), theme, size);
    // Both post-shrink frames must erase the same distance: if the footer
    // had crept upward, the second frame's cursorUp count would differ from
    // (and be smaller than) the steady-state count in the third frame.
    expect(cursorUpMatch(second)).toBe(cursorUpMatch(third));
    // The status bar (footer's own last line) must remain the last thing
    // written, not a blank padding row.
    const lastLine = second.split("\r\n").at(-1) ?? "";
    expect(lastLine).toContain("default");
  });

  it("finalize() does not reset a scroll region, just parks the cursor on a fresh line", () => {
    const r = new InlineRenderer(false);
    expect(r.finalize()).toBe("\r\n");
  });

  it("finalize() erases a previously painted footer instead of leaving it on screen", () => {
    // On win32 (no scroll region), the footer is pinned to the bottom by
    // erasing it and reprinting it fresh every frame. If finalize() (called
    // on /exit and Ctrl+C) skips that erase, the last footer -- the input
    // box and status bar -- is left behind on screen when control returns to
    // the shell, so the shell's next prompt gets printed overlapping it.
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    r.frame(buf, baseBottom(), theme, size);
    const out = r.finalize();
    expect(out).toBe("\x1b[2A\r\x1b[0J\r\n");
  });

  it("does not clear the screen itself on a column-width change (nativeApp's debounced resize handles that)", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    buf.append({ kind: "user", text: "hi" });
    r.frame(buf, baseBottom(), theme, { rows: size.rows, columns: 100 });
    const out = r.frame(buf, baseBottom(), theme, { rows: size.rows, columns: 100 });
    expect(out).not.toContain("\x1b[2J\x1b[3J\x1b[H");
  });

  it("parks the cursor with absolute addressing once the footer is bottom-anchored", () => {
    // After enough transcript rows have scrolled, the footer is pinned to
    // the bottom edge, so the input cursor cell is known absolutely: with
    // the 4-row test footer on a 24-row screen and the cursor on footer row
    // index 2, that is row 23 (1-based), column 3. Absolute placement makes
    // the cursor self-healing: it no longer depends on where the cursor
    // happened to be parked (relative moves inherit any out-of-band drift,
    // which strands IME/composition anchors — e.g. CJK input appearing in
    // the wrong corner of the embedded desktop terminal).
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    for (let i = 0; i < 30; i++) buf.append({ kind: "notice", text: `row ${i}` });
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain("\x1b[23;3H");
    expect(out.endsWith("\x1b]6973;input;22;2\x07")).toBe(true);
  });

  it("erases the previous footer with absolute addressing while still anchored", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    for (let i = 0; i < 30; i++) buf.append({ kind: "notice", text: `row ${i}` });
    r.frame(buf, baseBottom(), theme, size);
    const out = r.frame(buf, baseBottom(), theme, size);
    // Previous 4-row block occupied rows 21..24: jump straight there instead
    // of walking up from a possibly-drifted cursor.
    expect(out).toContain("\x1b[21;1H\x1b[0J");
    expect(out).toContain("\x1b[23;3H");
    expect(out.endsWith("\x1b]6973;input;22;2\x07")).toBe(true);
  });

  it("keeps relative cursor moves while the footer is not bottom-anchored", () => {
    // Fresh screen, almost no content: the footer floats mid-screen, so its
    // absolute position is unknowable and relative moves must stay.
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    buf.append({ kind: "user", text: "hi" });
    r.frame(buf, baseBottom(), theme, size);
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain("\x1b[2A\r\x1b[0J");
    expect(out.endsWith("\x1b[1A\r\x1b[2C")).toBe(true);
  });

  it("publishes the authoritative input cell once bottom-anchored", () => {
    const r = new InlineRenderer(false);
    const buf = new Buffer();
    for (let i = 0; i < 30; i++) buf.append({ kind: "notice", text: `row ${i}` });
    const out = r.frame(buf, baseBottom(), theme, size);
    expect(out).toContain("\x1b]6973;input;22;2\x07");
  });

  it("publishes no input cell while the input is hidden", () => {
    const hidden = baseBottom({
      overlay: "none",
      inputRender: {
        borderRows: [], contentRows: [], menuRows: [], hintRow: null,
        totalRows: 0, cursorRow: 0, cursorColumn: 0
      }
    });
    const r = new InlineRenderer(false);
    const out = r.frame(new Buffer(), hidden, theme, size);
    expect(out).not.toContain("6973");
  });
});