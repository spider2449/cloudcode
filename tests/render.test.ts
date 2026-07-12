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
    const inputTopRow = 10 - 1 /*status*/ - 3 /*input*/ + 1;
    expect(out).toContain(`\x1b[${inputTopRow};1H`);
  });

  it("caps a tall streaming preview to fit above the fixed-height footer region", () => {
    const buf = new Buffer();
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = render(buf, null, baseBottom({ streaming: true, streamingText: longText }), theme, { rows: 24, columns: 80 });
    expect(out).toContain("\x1b[24;1H");
    expect(out).not.toContain("line 0");
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
