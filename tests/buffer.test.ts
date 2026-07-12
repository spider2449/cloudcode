import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";
import type { DisplayItem } from "../src/ui/transcript.js";

const theme = THEMES.dark;

function notice(text: string): DisplayItem {
  return { kind: "notice", text };
}

describe("Buffer", () => {
  it("starts empty", () => {
    const buf = new Buffer();
    expect(buf.totalRows(80, theme)).toBe(0);
    expect(buf.visibleWindow(null, 5, 80, theme)).toEqual({ rows: [], tailRow: -1 });
  });

  it("append grows totalRows by the item's wrapped row count", () => {
    const buf = new Buffer();
    buf.append(notice("one line"));
    expect(buf.totalRows(80, theme)).toBe(1);
    buf.append(notice("a\nb\nc"));
    expect(buf.totalRows(80, theme)).toBe(4);
  });

  it("stick-to-bottom (startRow=null) returns the tail window", () => {
    const buf = new Buffer();
    for (let i = 0; i < 10; i++) buf.append(notice(`line${i}`));
    const { rows, tailRow } = buf.visibleWindow(null, 3, 80, theme);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("line9");
    expect(tailRow).toBe(9);
  });

  it("an absolute startRow returns rows starting at that offset", () => {
    const buf = new Buffer();
    for (let i = 0; i < 10; i++) buf.append(notice(`line${i}`));
    const { rows } = buf.visibleWindow(0, 3, 80, theme);
    expect(rows[0]).toContain("line0");
    expect(rows[2]).toContain("line2");
  });

  it("re-wraps correctly across a width change (resize)", () => {
    const buf = new Buffer();
    buf.append(notice("abcdefgh"));
    expect(buf.totalRows(4, theme)).toBe(2);
    expect(buf.totalRows(8, theme)).toBe(1);
  });

  it("clear empties the buffer", () => {
    const buf = new Buffer();
    buf.append(notice("x"));
    buf.clear();
    expect(buf.totalRows(80, theme)).toBe(0);
    expect(buf.visibleWindow(null, 5, 80, theme).tailRow).toBe(-1);
  });

  it("visibleWindow at the end of a short buffer returns fewer rows than height without padding", () => {
    const buf = new Buffer();
    buf.append(notice("only one line"));
    const { rows } = buf.visibleWindow(null, 5, 80, theme);
    expect(rows).toHaveLength(1);
  });
});
