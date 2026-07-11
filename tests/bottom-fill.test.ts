import { describe, it, expect } from "vitest";
import { itemRows, staticRows, fillerHeight } from "../src/ui/bottomFill.js";
import type { DisplayItem } from "../src/ui/transcript.js";

describe("itemRows", () => {
  it("counts a single-line notice as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "hello" }, 80)).toBe(1);
  });

  it("counts multi-line text by newlines", () => {
    expect(itemRows({ kind: "notice", text: "a\nb\nc" }, 80)).toBe(3);
  });

  it("counts wrapped lines: user prefix '> ' pushes 79 chars to 2 rows at width 80", () => {
    // "> " (2 chars) + 79 chars = 81 chars -> 2 rows
    expect(itemRows({ kind: "user", text: "x".repeat(79) }, 80)).toBe(2);
  });

  it("counts an empty line as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "" }, 80)).toBe(1);
  });

  it("result items are 1 row", () => {
    expect(itemRows({ kind: "result", costUsd: 0.01, durationMs: 1000 }, 80)).toBe(1);
  });

  it("diff items account for the 2-column margin", () => {
    // Each diff line renders as "+ xxx" in width (80 - 2) = 78.
    // sign+space (2) + 77 chars = 79 chars > 78 -> 2 rows.
    const lines = [{ sign: "+" as const, text: "y".repeat(77) }];
    expect(itemRows({ kind: "diff", lines }, 80)).toBe(2);
  });

  it("strips ANSI codes from assistant markdown before measuring", () => {
    // renderMarkdown emits ANSI-styled output; a short bold word must
    // still count as 1 row even though escape bytes inflate raw length.
    expect(itemRows({ kind: "assistant", text: "**hi**" }, 10)).toBe(1);
  });
});

describe("staticRows", () => {
  const notice = (text: string): DisplayItem => ({ kind: "notice", text });

  it("sums rows across items", () => {
    expect(staticRows([notice("a"), notice("b\nc")], 80, 100)).toBe(3);
  });

  it("early-exits at cap", () => {
    const items = Array.from({ length: 50 }, () => notice("line"));
    expect(staticRows(items, 80, 10)).toBe(10);
  });

  it("returns 0 for an empty transcript", () => {
    expect(staticRows([], 80, 24)).toBe(0);
  });
});

describe("fillerHeight", () => {
  it("fills unused space minus the 1-row reserve", () => {
    // 24 rows, 5 transcript rows, 6 live-region rows -> 24 - 5 - 6 - 1 = 12
    expect(fillerHeight(24, 5, 6)).toBe(12);
  });

  it("returns 0 on exact fit", () => {
    expect(fillerHeight(24, 17, 6)).toBe(0);
  });

  it("clamps to 0 on overflow", () => {
    expect(fillerHeight(24, 100, 6)).toBe(0);
  });
});
