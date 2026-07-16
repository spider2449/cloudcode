// tests/paste-coalesce.test.ts
import { describe, it, expect } from "vitest";
import { KeyDecoder, coalescePaste, type Key } from "../src/ui/input.js";

function feed(dec: KeyDecoder, s: string): Key[] {
  return dec.feed(Buffer.from(s, "utf8"));
}

describe("paste coalescing without bracketed paste (legacy conhost)", () => {
  it("coalesces a multi-line burst in one chunk into a single paste key", () => {
    const keys = feed(new KeyDecoder(), "line one\r\nline two\r\nline three");
    expect(keys).toEqual([{ t: "paste", text: "line one\nline two\nline three" }]);
  });
  it("coalesces a single-line burst (multiple printables) into a paste", () => {
    const keys = feed(new KeyDecoder(), "hello");
    expect(keys).toEqual([{ t: "paste", text: "hello" }]);
  });
  it("leaves a single keystroke alone", () => {
    expect(feed(new KeyDecoder(), "a")).toEqual([{ t: "printable", ch: "a" }]);
    expect(feed(new KeyDecoder(), "\r")).toEqual([{ t: "enter" }]);
  });
  it("leaves a single CJK character (IME input) alone", () => {
    expect(feed(new KeyDecoder(), "中")).toEqual([{ t: "printable", ch: "中" }]);
  });
  it("does not coalesce chunks containing escape sequences", () => {
    const keys = feed(new KeyDecoder(), "\x1b[Aab");
    expect(keys[0]).toEqual({ t: "up" });
    expect(keys.slice(1)).toEqual([{ t: "printable", ch: "a" }, { t: "printable", ch: "b" }]);
  });
  it("keeps bracketed paste working as before", () => {
    const keys = feed(new KeyDecoder(), "\x1b[200~pasted\r\ntext\x1b[201~");
    expect(keys).toEqual([{ t: "paste", text: "pasted\r\ntext" }]);
  });
  it("converts CR, LF and CRLF inside a burst to \\n and tabs to \\t", () => {
    const keys = feed(new KeyDecoder(), "a\rb\nc\td");
    expect(keys).toEqual([{ t: "paste", text: "a\nb\nc\td" }]);
  });
});

describe("coalescePaste unit", () => {
  it("returns keys unchanged when any key is not printable/enter/tab", () => {
    const keys: Key[] = [{ t: "printable", ch: "a" }, { t: "backspace" }];
    expect(coalescePaste(keys)).toBe(keys);
  });
});
