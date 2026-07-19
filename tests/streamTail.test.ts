import { describe, it, expect } from "vitest";
import { tailForHeight } from "../src/ui/streamTail.js";

describe("tailForHeight", () => {
  it("returns short text unchanged", () => {
    expect(tailForHeight("hello\nworld", 10, 80)).toBe("hello\nworld");
  });

  it("keeps only the last lines when text exceeds max rows", () => {
    const text = ["a", "b", "c", "d", "e"].join("\n");
    expect(tailForHeight(text, 3, 80)).toBe("c\nd\ne");
  });

  it("counts wrapped rows for lines longer than the terminal width", () => {
    // 25-char line wraps to 3 rows at width 10, so with maxRows 4 only
    // that line plus one more fits.
    const long = "x".repeat(25);
    const text = ["first", "second", long, "last"].join("\n");
    expect(tailForHeight(text, 4, 10)).toBe(`${long}\nlast`);
  });

  it("treats empty lines as one row", () => {
    const text = "a\n\nb\n\nc";
    expect(tailForHeight(text, 3, 80)).toBe("b\n\nc");
  });

  it("returns at least the last line even if it alone exceeds max rows", () => {
    const long = "y".repeat(50);
    expect(tailForHeight(`a\n${long}`, 2, 10)).toBe(long);
  });
});

describe("tailForHeight CJK rows", () => {
  it("counts a CJK line as its column width, not char count", () => {
    // 10 CJK chars = 20 columns = 2 rows at width 10.
    const text = ["第一行的中文內容啊啊", "second"].join("\n");
    // maxRows 2: the CJK line alone already fills 2 rows, so only the last
    // line(s) fitting must be kept.
    const out = tailForHeight(text, 2, 10);
    expect(out).toBe("second");
  });
});
