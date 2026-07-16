import { describe, it, expect } from "vitest";
import { wrapText, stripAnsi } from "../src/ui/layout.js";
import { stringWidth } from "../src/ui/width.js";

describe("wrapText (column-aware)", () => {
  it("wraps CJK by columns: 6 wide chars at width 10 -> rows of 5+1 chars? no: 3 rows? -> 2 rows", () => {
    // 6 CJK chars = 12 columns; width 10 fits 5 chars (10 cols) per row.
    const rows = wrapText("中文字符串測", 10);
    expect(rows).toEqual(["中文字符串", "測"]);
  });
  it("never emits a row wider than the limit", () => {
    const rows = wrapText("中a文b字c符d串e測f", 7);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(7);
  });
  it("breaks at word boundaries for ASCII", () => {
    expect(wrapText("hello brave new world", 11)).toEqual(["hello brave", "new world"]);
  });
  it("hard-cuts a single word longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("allows breaking anywhere in CJK runs", () => {
    expect(wrapText("這是一段很長的中文句子", 8)).toEqual(["這是一段", "很長的中", "文句子"]);
  });
  it("preserves explicit newlines and blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
  it("keeps ANSI codes attached without counting them", () => {
    const rows = wrapText("\x1b[31mred\x1b[0m and more text", 8);
    expect(stripAnsi(rows[0])).toBe("red and");
    expect(rows[0]).toContain("\x1b[31m");
  });
  it("mixed CJK and ASCII wraps by columns", () => {
    // "ab中文" = 2 + 4 = 6 columns; width 5 → "ab中" (4 cols, next char won't fit)
    expect(wrapText("ab中文", 5)).toEqual(["ab中", "文"]);
  });
  it("hard-cuts a single wide char that alone exceeds the width, without hanging", () => {
    // A CJK char is 2 columns wide; width 1 can never fit it. Must not loop
    // forever, and must not drop the character.
    const start = Date.now();
    const rows = wrapText("中", 1);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(rows).toEqual(["中"]);
  });
  it("hard-cuts multiple over-wide chars each onto their own row at width 1", () => {
    const start = Date.now();
    const rows = wrapText("中文", 1);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(rows).toEqual(["中", "文"]);
  });
});
