import { describe, it, expect } from "vitest";
import { compactHistory, estimateTokens } from "../src/engine/compact.js";

function makeClient() {
  let lastRequest: { messages: Array<{ role: string }> } | undefined;
  return {
    client: {
      async *create(req: { messages: Array<{ role: string }> }) {
        lastRequest = req;
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "user asked about X" } } as never;
        yield { type: "message_stop" } as never;
      }
    },
    getLastRequest: () => lastRequest
  };
}

describe("compactHistory", () => {
  it("replaces history with a single summary user message", async () => {
    const { client } = makeClient();
    const next = await compactHistory(client as never, "m", [{ role: "user", content: "long stuff" }]);
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next[0])).toContain("user asked about X");
  });

  it("does not send consecutive user-role messages when history ends on a tool-result user turn", async () => {
    const { client, getLastRequest } = makeClient();
    await compactHistory(client as never, "m", [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] }
    ]);
    const roles = getLastRequest()!.messages.map(m => m.role);
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });
});

describe("estimateTokens", () => {
  it("estimates a much smaller size for compacted history than the original", () => {
    const original = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `message number ${i} `.repeat(20) }));
    const compacted = [{ role: "user", content: "Summary of prior conversation: short recap." }];
    expect(estimateTokens(compacted)).toBeLessThan(estimateTokens(original));
  });
});
