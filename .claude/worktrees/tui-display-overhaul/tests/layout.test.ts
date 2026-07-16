import { describe, it, expect } from "vitest";
import { stripAnsi, wrapText, layoutItem } from "../src/ui/layout.js";
import { THEMES } from "../src/ui/theme.js";
import type { DisplayItem } from "../src/ui/transcript.js";

const theme = THEMES.dark;

describe("stripAnsi", () => {
  it("removes SGR escapes and leaves plain text", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });
});

describe("wrapText", () => {
  it("returns the text unwrapped when it fits", () => {
    expect(wrapText("hello", 10)).toEqual(["hello"]);
  });

  it("wraps a single long line at width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("preserves explicit newlines as separate wrap units", () => {
    expect(wrapText("ab\ncdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  it("returns one empty row for an empty string", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("ignores ANSI escapes when measuring width", () => {
    const styled = "\x1b[31mabcd\x1b[0mefgh";
    expect(wrapText(styled, 4).length).toBe(2);
  });
});

describe("layoutItem", () => {
  it("formats a user item with '> ' prefix in theme.user color", () => {
    const item: DisplayItem = { kind: "user", text: "hi" };
    const rows = layoutItem(item, theme, 80);
    expect(rows.join("\n")).toContain("> hi");
  });

  it("formats a tool item with the accent-colored circle-dot prefix", () => {
    const item: DisplayItem = { kind: "tool", label: "Read foo.ts" };
    const rows = layoutItem(item, theme, 80);
    expect(rows.join("\n")).toContain("● Read foo.ts");
  });

  it("formats a result item as one summary row", () => {
    const item: DisplayItem = { kind: "result", costUsd: 0.01, durationMs: 2500 };
    const rows = layoutItem(item, theme, 80);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("✓ done");
    expect(rows[0]).toContain("$0.0100");
    expect(rows[0]).toContain("2.5s");
  });

  it("formats a diff item with left-padded sign-prefixed lines wrapped inside width-2", () => {
    const item: DisplayItem = {
      kind: "diff",
      lines: [{ sign: "+", text: "added" }, { sign: "-", text: "removed" }]
    };
    const rows = layoutItem(item, theme, 20);
    expect(rows.some(r => r.includes("+ added"))).toBe(true);
    expect(rows.some(r => r.includes("- removed"))).toBe(true);
  });

  it("wraps a long assistant markdown line at the given width", () => {
    const item: DisplayItem = { kind: "assistant", text: "word ".repeat(30).trim() };
    const rows = layoutItem(item, theme, 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(stripAnsi(r).length).toBeLessThanOrEqual(20);
  });

  it("prefixes an assistant message with a circle dot and indents wrapped continuation lines", () => {
    const item: DisplayItem = { kind: "assistant", text: "word ".repeat(30).trim() };
    const rows = layoutItem(item, theme, 20).map(stripAnsi);
    expect(rows[0].startsWith("● ")).toBe(true);
    for (const r of rows.slice(1)) expect(r.startsWith("  ")).toBe(true);
  });

  it("a single-line assistant message only gets the dot, no continuation indent needed", () => {
    const item: DisplayItem = { kind: "assistant", text: "hi there" };
    const rows = layoutItem(item, theme, 80).map(stripAnsi);
    expect(rows).toEqual(["● hi there"]);
  });
});
