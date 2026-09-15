import { describe, expect, it } from "vitest";
import { toChatEvents } from "../src/desktop/chatEvents.js";
import { mergeAssistantFinal } from "../src/desktop/renderer/chatHelpers.js";

describe("desktop duplicate assistant text", () => {
  it("emits final assistant blocks as assistant_text, not text_delta", () => {
    expect(
      toChatEvents("7", { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    ).toEqual([{ id: "7", type: "assistant_text", text: "hello" }]);
  });

  it("streaming deltas still emit text_delta", () => {
    expect(
      toChatEvents("7", {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }),
    ).toEqual([{ id: "7", type: "text_delta", text: "hi" }]);
  });

  it("ignores a final that duplicates already-streamed text", () => {
    const msgs = [{ id: "7", role: "assistant" as const, text: "hello" }];
    expect(mergeAssistantFinal(msgs, "7", "hello")).toEqual(msgs);
  });

  it("appends a final notice that was never streamed", () => {
    const msgs = [{ id: "7", role: "assistant" as const, text: "hello" }];
    expect(mergeAssistantFinal(msgs, "7", "\n[Response truncated]")).toEqual([
      { id: "7", role: "assistant", text: "hello\n[Response truncated]" },
    ]);
  });
});
