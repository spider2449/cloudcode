import { describe, it, expect } from "vitest";
import { toDisplayItems, toolLabel } from "../src/ui/transcript.js";
import type { EngineMessage } from "../src/engine/messages.js";

describe("toolLabel", () => {
  it("shows file path for file tools", () => {
    expect(toolLabel("Read", { file_path: "/a/b.ts" })).toBe("Read /a/b.ts");
  });
  it("truncates long bash commands to 80 chars of detail", () => {
    const label = toolLabel("Bash", { command: "x".repeat(200) });
    expect(label.startsWith("Bash ")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(85);
  });
});

describe("toDisplayItems", () => {
  it("maps assistant text and tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: { content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", name: "Read", input: { file_path: "/x.ts" } }
      ] }
    } as unknown as EngineMessage;
    expect(toDisplayItems(msg)).toEqual([
      { kind: "assistant", text: "Let me look." },
      { kind: "tool", label: "Read /x.ts" }
    ]);
  });

  it("maps success result to result item", () => {
    const msg = {
      type: "result", subtype: "success", total_cost_usd: 0.02, duration_ms: 1200
    } as unknown as EngineMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "result", costUsd: 0.02, durationMs: 1200 }]);
  });

  it("maps error result to error item", () => {
    const msg = {
      type: "result", subtype: "error_during_execution", result: "boom"
    } as unknown as EngineMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "error", text: "boom" }]);
  });

  it("ignores system messages", () => {
    expect(toDisplayItems({ type: "system", subtype: "init" } as unknown as EngineMessage)).toEqual([]);
  });
});

import { streamDelta, diffLines } from "../src/ui/transcript.js";

describe("streamDelta", () => {
  it("extracts text deltas from stream events", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } }
    } as unknown as EngineMessage;
    expect(streamDelta(msg)).toBe("hel");
  });

  it("returns undefined for other messages and non-text deltas", () => {
    expect(streamDelta({ type: "assistant", message: { content: [] } } as unknown as EngineMessage)).toBeUndefined();
    expect(streamDelta({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } }
    } as unknown as EngineMessage)).toBeUndefined();
  });
});

describe("diffLines", () => {
  it("maps Edit old/new strings to -/+ lines", () => {
    expect(diffLines("Edit", { old_string: "a\nb", new_string: "c" })).toEqual([
      { sign: "-", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "c" }
    ]);
  });

  it("maps Write content to + lines and caps with ellipsis", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = diffLines("Write", { content });
    expect(lines).toHaveLength(21);
    expect(lines[20]).toEqual({ sign: " ", text: "… (+10 more)" });
  });

  it("returns empty for other tools", () => {
    expect(diffLines("Bash", { command: "ls" })).toEqual([]);
  });
});

describe("toDisplayItems diff emission", () => {
  it("emits a diff item after Edit tool chips", () => {
    const msg = {
      type: "assistant",
      message: { content: [
        { type: "tool_use", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }
      ] }
    } as unknown as EngineMessage;
    const items = toDisplayItems(msg);
    expect(items[0].kind).toBe("tool");
    expect(items[1]).toEqual({
      kind: "diff",
      lines: [{ sign: "-", text: "a" }, { sign: "+", text: "b" }]
    });
  });
});
