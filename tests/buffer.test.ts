import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";
import { THEMES } from "../src/ui/theme.js";

const theme = THEMES.dark;

describe("Buffer commit semantics", () => {
  it("takeCommitRows returns nothing for an empty buffer", () => {
    const buf = new Buffer();
    expect(buf.takeCommitRows(80, theme)).toEqual([]);
  });

  it("returns rows for appended items exactly once", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "one" });
    buf.append({ kind: "notice", text: "a\nb\nc" });
    const first = buf.takeCommitRows(80, theme);
    expect(first.length).toBe(4); // 1 + 3 laid-out rows
    expect(first.join("\n")).toContain("one");
    // Second call: nothing new was appended, nothing is re-emitted.
    expect(buf.takeCommitRows(80, theme)).toEqual([]);
  });

  it("items appended after a commit are returned by the next commit", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "first" });
    buf.takeCommitRows(80, theme);
    buf.append({ kind: "notice", text: "second" });
    const rows = buf.takeCommitRows(80, theme);
    expect(rows.join("\n")).toContain("second");
    expect(rows.join("\n")).not.toContain("first");
  });

  it("wraps uncommitted items at the width passed to takeCommitRows", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "aaaa bbbb" });
    expect(buf.takeCommitRows(4, theme).length).toBeGreaterThan(1);
  });

  it("clear() resets the committed marker so re-appended items commit again", () => {
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "x" });
    buf.takeCommitRows(80, theme);
    buf.clear();
    expect(buf.itemCount).toBe(0);
    buf.append({ kind: "notice", text: "y" });
    expect(buf.takeCommitRows(80, theme).join("\n")).toContain("y");
  });
});
