import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scripted fake: each call to create() yields the next scripted event array.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    async *create() {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

// A provider turn that reports no usage at all, like llama.cpp over the
// OpenAI-compatible path when it omits usage chunks.
const bigTextTurnNoUsage = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" }
];

const summaryTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" }
];

function makeLoop(client: ReturnType<typeof fakeClient>, received: unknown[], contextWindow: number) {
  return new EngineLoop({
    client,
    model: "test-model",
    systemPrompt: "sys",
    tools: [],
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-ac-"))),
    contextWindow,
    onMessage: m => received.push(m),
    requestPermission: async () => true
  });
}

describe("EngineLoop usage-less auto-compact fallback", () => {
  it("compacts history past the threshold when the provider reports no usage", async () => {
    const received: unknown[] = [];
    // contextWindow 200 -> 80% threshold is 160 tokens (~640 chars).
    const client = fakeClient([bigTextTurnNoUsage("x".repeat(2000)), summaryTurn("dense summary")]);
    const loop = makeLoop(client, received, 200);
    await loop.runTurn("hi", new AbortController().signal);
    // History must have been replaced by the compacted 2-message summary,
    // not left holding the unbounded turn output.
    expect(JSON.stringify(loop.messages)).toContain("Summary of prior conversation");
    expect(JSON.stringify(loop.messages)).not.toContain("x".repeat(100));
  });

  it("leaves compaction to the UI path when the provider reports usage", async () => {
    const received: unknown[] = [];
    const withUsage = (text: string) => [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10000, output_tokens: 5 } },
      { type: "message_stop" }
    ];
    const client = fakeClient([withUsage("y".repeat(2000))]);
    const loop = makeLoop(client, received, 200);
    await loop.runTurn("hi", new AbortController().signal);
    // Engine must not double-compact: usage-driven compaction belongs to the
    // UI usageTracker path after the result message.
    expect(client.calls).toBe(1);
    expect(JSON.stringify(loop.messages)).toContain("y".repeat(100));
    expect(JSON.stringify(loop.messages)).not.toContain("Summary of prior conversation");
  });

  it("does nothing below the threshold", async () => {
    const received: unknown[] = [];
    const client = fakeClient([bigTextTurnNoUsage("small")]);
    const loop = makeLoop(client, received, 200000);
    await loop.runTurn("hi", new AbortController().signal);
    expect(client.calls).toBe(1);
    expect(loop.messages).toHaveLength(2);
  });
});
