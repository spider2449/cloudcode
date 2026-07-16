import { describe, it, expect } from "vitest";
import { charWidth, stringWidth, truncateToWidth } from "../src/ui/width.js";

describe("charWidth", () => {
  it("gives ASCII width 1", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
  });
  it("gives CJK ideographs width 2", () => {
    expect(charWidth("中".codePointAt(0)!)).toBe(2);
    expect(charWidth("文".codePointAt(0)!)).toBe(2);
  });
  it("gives kana and hangul width 2", () => {
    expect(charWidth("あ".codePointAt(0)!)).toBe(2);
    expect(charWidth("한".codePointAt(0)!)).toBe(2);
  });
  it("gives fullwidth forms width 2", () => {
    expect(charWidth("Ａ".codePointAt(0)!)).toBe(2);
    expect(charWidth("，".codePointAt(0)!)).toBe(2);
  });
  it("gives emoji width 2", () => {
    expect(charWidth("😀".codePointAt(0)!)).toBe(2);
  });
  it("gives combining marks, ZWJ and variation selectors width 0", () => {
    expect(charWidth(0x0301)).toBe(0); // combining acute
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // variation selector-16
  });
  it("gives control characters width 0", () => {
    expect(charWidth(0x1b)).toBe(0);
  });
});

describe("stringWidth", () => {
  it("sums mixed ASCII and CJK", () => {
    expect(stringWidth("ab中文")).toBe(6);
  });
  it("ignores ANSI SGR sequences", () => {
    expect(stringWidth("\x1b[31m中\x1b[0m")).toBe(2);
  });
  it("handles surrogate-pair emoji as one code point", () => {
    expect(stringWidth("😀")).toBe(2);
  });
  it("returns 0 for empty string", () => {
    expect(stringWidth("")).toBe(0);
  });
});

describe("truncateToWidth", () => {
  it("returns short strings unchanged", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
  });
  it("truncates by columns, not chars", () => {
    // 5 CJK chars = 10 columns; max 6 leaves room for 5 columns + ellipsis
    expect(truncateToWidth("中文字符串", 6)).toBe("中文…");
  });
  it("truncates ASCII to max-1 columns plus ellipsis", () => {
    expect(truncateToWidth("abcdefgh", 5)).toBe("abcd…");
  });
  it("never splits a wide char in half", () => {
    // "a" + "中" would be 3 columns; max 4 minus ellipsis leaves 3 → fits "a中"
    expect(truncateToWidth("a中文文", 4)).toBe("a中…");
  });
});
