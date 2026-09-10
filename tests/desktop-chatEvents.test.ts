import { describe, expect, it } from "vitest";
import { fromApiMessages, toChatEvents } from "../src/desktop/chatEvents.js";

describe("toChatEvents", () => {
  it("maps text deltas and assistant text blocks", () => {
    expect(toChatEvents("7", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } })).toEqual([
      { id: "7", type: "text_delta", text: "hi" },
    ]);
    expect(toChatEvents("7", { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })).toEqual([
      { id: "7", type: "text_delta", text: "hello" },
    ]);
  });
  it("maps tool activity and errors, ignores control messages", () => {
    expect(toChatEvents("7", { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }] } })).toEqual([
      { id: "7", type: "tool_use", toolName: "Read", toolInput: { path: "a" } },
    ]);
    expect(toChatEvents("7", { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false })).toEqual([
      { id: "7", type: "tool_result", text: "ok" },
    ]);
    expect(toChatEvents("7", { type: "result", subtype: "error_during_execution", result: "boom" })).toEqual([
      { id: "7", type: "error", text: "boom" },
    ]);
    expect(toChatEvents("7", { type: "system", subtype: "init", session_id: "s", tools: [] })).toEqual([]);
    expect(toChatEvents("7", { type: "result", subtype: "success", duration_ms: 1 })).toEqual([]);
  });
  it("replays persisted API messages, ignoring todos records", () => {
    expect(
      fromApiMessages("h", [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { path: "a" } }] },
        { type: "todos", todos: [] },
        { role: "user", content: [{ type: "text", text: "blocks" }] },
      ]),
    ).toEqual([
      { id: "h", type: "user_text", text: "hello" },
      { id: "h", type: "text_delta", text: "hi" },
      { id: "h", type: "tool_use", toolName: "Read", toolInput: { path: "a" } },
    ]);
  });
});
