import { describe, expect, it } from "vitest";
import { requireChatId, requireChatText, CHAT_EVENT_TYPES } from "../src/desktop/chatProtocol.js";

describe("chat protocol", () => {
  it("accepts a bounded message id and text", () => {
    expect(requireChatId("abc-123")).toBe("abc-123");
    expect(requireChatText("hello")).toBe("hello");
  });
  it("rejects empty and oversized payloads", () => {
    expect(() => requireChatId("")).toThrow("Invalid chat id");
    expect(() => requireChatText("")).toThrow("Invalid chat text");
    expect(() => requireChatText("x".repeat(200_001))).toThrow("Invalid chat text");
  });
  it("advertises a fixed event vocabulary", () => {
    expect(CHAT_EVENT_TYPES).toEqual(["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "done"]);
  });
  it("rejects control characters and non-strings, accepts boundary lengths", () => {
    expect(() => requireChatId("x".repeat(201))).toThrow("Invalid chat id");
    expect(() => requireChatId(null)).toThrow("Invalid chat id");
    expect(() => requireChatId(123)).toThrow("Invalid chat id");
    expect(() => requireChatText(null)).toThrow("Invalid chat text");
    expect(() => requireChatText(123)).toThrow("Invalid chat text");
    expect(() => requireChatId("a\nb")).toThrow("Invalid chat id");
    expect(requireChatId("x".repeat(200))).toBe("x".repeat(200));
    expect(requireChatText("x".repeat(200_000))).toBe("x".repeat(200_000));
  });
});
