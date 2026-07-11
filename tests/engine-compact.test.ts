import { describe, it, expect } from "vitest";
import { compactHistory } from "../src/engine/compact.js";

const fakeClient = {
  async *create() {
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never;
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "user asked about X" } } as never;
    yield { type: "message_stop" } as never;
  }
};

describe("compactHistory", () => {
  it("replaces history with a single summary user message", async () => {
    const next = await compactHistory(fakeClient as never, "m", [{ role: "user", content: "long stuff" }]);
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next[0])).toContain("user asked about X");
  });
});
