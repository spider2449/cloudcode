import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";

const theme = {} as never;

describe("transcript spacing", () => {
  it("puts a blank row before user and assistant items, but not the first item", () => {
    const b = new Buffer();
    b.append({ kind: "user", text: "hi" });
    b.append({ kind: "assistant", text: "hello" });
    const rows = b.takeCommitRows(80, theme);
    expect(rows[0]).not.toBe("");            // no leading blank at the top
    expect(rows).toContain("");              // blank separator exists
    const blankIdx = rows.indexOf("");
    expect(rows[blankIdx + 1]).toContain("hello"); // separator sits before the assistant block
  });
  it("keeps tool items tight against the previous item", () => {
    const b = new Buffer();
    b.append({ kind: "assistant", text: "x" });
    b.append({ kind: "tool", label: "Bash ls" });
    const rows = b.takeCommitRows(80, theme);
    expect(rows.filter(r => r === "").length).toBe(0);
  });
  it("spacing survives recommitAll (resize reprint)", () => {
    const b = new Buffer();
    b.append({ kind: "user", text: "a" });
    b.append({ kind: "user", text: "b" });
    b.takeCommitRows(80, theme);
    b.recommitAll();
    const again = b.takeCommitRows(80, theme);
    expect(again.filter(r => r === "").length).toBe(1);
  });
});
