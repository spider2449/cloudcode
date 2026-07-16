import { describe, it, expect } from "vitest";
import { toDisplayItems } from "../src/ui/transcript.js";
import { layoutItem } from "../src/ui/layout.js";
import { toolResultMessage } from "../src/engine/messages.js";
import { stripAnsi } from "../src/ui/layout.js";

const theme = { muted: "gray", error: "red" } as never;

describe("tool_result display", () => {
  it("maps a string result to a one-line preview with extra-line count", () => {
    const items = toDisplayItems(toolResultMessage("t1", "line one\nline two\nline three", false));
    expect(items).toEqual([{ kind: "toolResult", text: "line one", extra: 2, isError: false }]);
  });
  it("maps structured content blocks by joining their text", () => {
    const items = toDisplayItems(toolResultMessage("t1", [{ type: "text", text: "hello" }], false));
    expect(items).toEqual([{ kind: "toolResult", text: "hello", extra: 0, isError: false }]);
  });
  it("shows (no output) for empty content", () => {
    const items = toDisplayItems(toolResultMessage("t1", "", false));
    expect(items).toEqual([{ kind: "toolResult", text: "(no output)", extra: 0, isError: false }]);
  });
  it("marks errors", () => {
    const items = toDisplayItems(toolResultMessage("t1", "boom", true));
    expect(items[0]).toMatchObject({ isError: true });
  });
  it("renders as an indented ⎿ line, width-truncated", () => {
    const rows = layoutItem({ kind: "toolResult", text: "x".repeat(200), extra: 3, isError: false }, theme, 40);
    expect(rows.length).toBe(1);
    const plain = stripAnsi(rows[0]);
    expect(plain.startsWith("  ⎿ ")).toBe(true);
    expect(plain.length).toBeLessThanOrEqual(40);
    expect(plain.endsWith("…")).toBe(true);
  });
  it("appends the extra-line suffix when it fits", () => {
    const rows = layoutItem({ kind: "toolResult", text: "ok", extra: 4, isError: false }, theme, 40);
    expect(stripAnsi(rows[0])).toBe("  ⎿ ok (+4 lines)");
  });
});
