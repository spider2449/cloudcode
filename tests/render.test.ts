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
    thinkingText: "",
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
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(buf, baseBottom({ thinkingText: "pondering...", streamingText: "" }), theme, size);
    expect(out).toContain("○ pondering...");
    expect(out).toContain("\x1b[35m");
  });
});
