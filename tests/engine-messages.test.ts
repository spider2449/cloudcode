import { describe, it, expect } from "vitest";
import { textDelta, assistantMessage, errorResult } from "../src/engine/messages.js";

describe("engine message constructors", () => {
  it("builds a stream_event carrying a text delta", () => {
    expect(textDelta("hi")).toEqual({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }
    });
  });

  it("builds an assistant message from content blocks", () => {
    const blocks = [{ type: "text" as const, text: "hello" }];
    expect(assistantMessage(blocks)).toEqual({ type: "assistant", message: { content: blocks } });
  });

  it("builds an error result", () => {
    expect(errorResult("boom")).toEqual({ type: "result", subtype: "error_during_execution", result: "boom" });
  });
});
