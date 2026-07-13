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
