import { describe, it, expect } from "vitest";
import { toDisplayItems, toolLabel } from "../src/ui/transcript.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([
      { kind: "assistant", text: "Let me look." },
      { kind: "tool", label: "Read /x.ts" }
    ]);
  });

  it("maps success result to result item", () => {
    const msg = {
      type: "result", subtype: "success", total_cost_usd: 0.02, duration_ms: 1200
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "result", costUsd: 0.02, durationMs: 1200 }]);
  });

  it("maps error result to error item", () => {
    const msg = {
      type: "result", subtype: "error_during_execution", result: "boom"
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "error", text: "boom" }]);
  });

  it("ignores system messages", () => {
    expect(toDisplayItems({ type: "system", subtype: "init" } as unknown as SDKMessage)).toEqual([]);
  });
});
