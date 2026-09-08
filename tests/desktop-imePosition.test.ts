import { describe, expect, it } from "vitest";
import { imeAnchor, pickMeasureElement, scanInputCell } from "../desktop/renderer/imePosition.js";

describe("imeAnchor", () => {
  it("positions the helper textarea at the visible cursor cell", () => {
    expect(imeAnchor(6, 18, 10, 80, 24, 800, 480)).toEqual({
      left: 60,
      top: 160,
      height: 20
    });
  });

  it("clamps stale cursor coordinates to the terminal viewport", () => {
    expect(imeAnchor(100, 4, 10, 80, 24, 800, 480)).toEqual({
      left: 790,
      top: 0,
      height: 20
    });
  });

  it("accounts for scrollback: visible row is cursorY + baseY - viewportY", () => {
    // xterm's public cursorY is relative to baseY (0 when the cursor is at
    // baseY), while viewportY is the absolute buffer line of the viewport
    // top. A live session with scrollback following the tail has
    // viewportY == baseY, so the visible row equals cursorY.
    expect(imeAnchor(4, 20, 5000, 80, 24, 800, 480, 5000)).toEqual({
      left: 40,
      top: 400,
      height: 20
    });
  });

  it("clamps the scrollback-adjusted row to the viewport", () => {
    // Scrolled back: cursor below the visible viewport pins to the last row.
    expect(imeAnchor(4, 20, 4990, 80, 24, 800, 480, 5000)).toEqual({
      left: 40,
      top: 460,
      height: 20
    });
  });
});

describe("scanInputCell", () => {
  it("parses a complete input-cell OSC", () => {
    const scanned = scanInputCell("abc\x1b]6973;input;22;2\x07def", "");
    expect(scanned.cell).toEqual({ row: 22, col: 2 });
    expect(scanned.cleared).toBe(false);
    expect(scanned.pending).toBe("");
  });

  it("lets the last complete OSC win", () => {
    const scanned = scanInputCell(
      "\x1b]6973;input;10;3\x07mid\x1b]6973;input;22;2\x07", ""
    );
    expect(scanned.cell).toEqual({ row: 22, col: 2 });
  });

  it("ignores text without an OSC", () => {
    const scanned = scanInputCell("> hello\r\nworld", "");
    expect(scanned.cell).toBeUndefined();
    expect(scanned.cleared).toBe(false);
    expect(scanned.pending).toBe("");
  });

  it("reassembles an OSC split across chunks", () => {
    const first = scanInputCell("abc\x1b]6973;inp", "");
    expect(first.cell).toBeUndefined();
    const second = scanInputCell("ut;22;2\x07def", first.pending);
    expect(second.cell).toEqual({ row: 22, col: 2 });
    expect(second.pending).toBe("");
  });

  it("reports a screen clear so stale cells are dropped", () => {
    const scanned = scanInputCell("foo\x1b[2Jbar", "");
    expect(scanned.cleared).toBe(true);
    expect(scanned.cell).toBeUndefined();
  });
});

describe("pickMeasureElement", () => {
  it("prefers the canvas, which has real layout size", () => {
    const canvas = {} as Element;
    const screen = {} as Element;
    const host = {
      querySelector: (sel: string) => (sel.includes("canvas") ? canvas : screen)
    };
    expect(pickMeasureElement(host)).toBe(canvas);
  });

  it("falls back to the screen element when there is no canvas yet", () => {
    const screen = {} as Element;
    const host = {
      querySelector: (sel: string) => (sel.includes("canvas") ? null : screen)
    };
    expect(pickMeasureElement(host)).toBe(screen);
  });
});
