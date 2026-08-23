import { describe, it, expect, beforeAll } from "vitest";
import { highlightCode } from "../src/ui/markdown/highlight.js";
import { paint } from "../src/ui/markdown/style.js";
import { setColorDepth } from "../src/ui/term/ansi.js";

// Hex expectations below assume truecolor output; CI terminals report 16-color
// depth, so pin it explicitly instead of relying on the host environment.
beforeAll(() => setColorDepth("truecolor"));

describe("highlightCode", () => {
  it("highlights known languages without changing content", () => {
    const out = highlightCode("const x = 1;", "js");
    // Highlighting wraps tokens in SGR codes, so only the stripped text is
    // guaranteed to be contiguous.
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("const x = 1;");
    expect(out).toContain("\x1b[");
  });

  it("returns plain text for unknown or missing languages", () => {
    expect(highlightCode("hello", "nope")).toBe("hello");
    expect(highlightCode("hello", undefined)).toBe("hello");
  });

  it("never throws on malformed input", () => {
    expect(() => highlightCode("\ud800 broken", "js")).not.toThrow();
  });
});

describe("paint", () => {
  it("wraps text in color codes and resets", () => {
    expect(paint("#ff0000")("hi")).toBe("\x1b[38;2;255;0;0mhi\x1b[0m");
  });
  it("is identity without color", () => {
    expect(paint(undefined)("hi")).toBe("hi");
  });
});
