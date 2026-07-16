import { describe, it, expect } from "vitest";
import { diffLines } from "../src/ui/transcript.js";

describe("Edit line diff", () => {
  it("shows only changed lines with context, not full old+new dumps", () => {
    const oldS = ["a", "b", "c", "d", "e"].join("\n");
    const newS = ["a", "b", "X", "d", "e"].join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines).toEqual([
      { sign: " ", text: "a" },
      { sign: " ", text: "b" },
      { sign: "-", text: "c" },
      { sign: "+", text: "X" },
      { sign: " ", text: "d" },
      { sign: " ", text: "e" }
    ]);
  });
  it("collapses long unchanged runs to 2 context lines each side", () => {
    const mid = Array.from({ length: 10 }, (_, i) => `same${i}`);
    const oldS = ["start", ...mid, "old-end"].join("\n");
    const newS = ["start", ...mid, "new-end"].join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines.some(l => l.sign === " " && l.text === "…")).toBe(true);
    // Only 2 context lines survive right before the change.
    const changeIdx = lines.findIndex(l => l.sign === "-");
    expect(lines[changeIdx - 1]).toEqual({ sign: " ", text: "same9" });
    expect(lines[changeIdx - 2]).toEqual({ sign: " ", text: "same8" });
    expect(lines[changeIdx - 3]).toEqual({ sign: " ", text: "…" });
  });
  it("keeps the Write all-additions behavior", () => {
    const lines = diffLines("Write", { content: "a\nb" });
    expect(lines).toEqual([
      { sign: "+", text: "a" },
      { sign: "+", text: "b" }
    ]);
  });
  it("keeps the row cap with overflow marker", () => {
    const oldS = Array.from({ length: 30 }, (_, i) => `o${i}`).join("\n");
    const newS = Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines.length).toBe(21);
    expect(lines[20].text).toMatch(/more/);
  });
  it("falls back to the dump format when strings are missing", () => {
    const lines = diffLines("Edit", { new_string: "x" });
    expect(lines).toEqual([{ sign: "+", text: "x" }]);
  });
});
