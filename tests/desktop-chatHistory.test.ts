import { describe, expect, it } from "vitest";
import { loadHistoryEvents } from "../src/desktop/chatHistory.js";

describe("loadHistoryEvents", () => {
  it("returns empty history for a new (undefined) session instead of throwing", () => {
    expect(loadHistoryEvents("history-1", undefined)).toEqual([]);
  });
  it("rejects truly invalid session ids", () => {
    expect(() => loadHistoryEvents("history-2", "")).toThrow("Invalid chat id");
  });
});
