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
  return makeLoopWithTools(client, received, contextWindow, []);
}

const echoTool = {
  name: "EchoTool",
  description: "echoes",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute(input: unknown) {
    return { content: `echo:${JSON.stringify(input)}` };
  }
};

function makeLoopWithTools(
  client: ReturnType<typeof fakeClient>,
  received: unknown[],
  contextWindow: number,
  tools: Array<{ name: string; description: string; input_schema: unknown; execute: (input: never) => Promise<{ content: string }> }>
) {
  return new EngineLoop({
    client,
    model: "test-model",
    systemPrompt: "sys",
    tools: tools as never,
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-ac-"))),
    contextWindow,
    onMessage: m => received.push(m),
    requestPermission: async () => true
  });
}

const toolUseWithLargeUsage = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10000, output_tokens: 5 } },
  { type: "message_stop" }
];

const finalTextTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

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

  it("compacts mid-turn when reported input_tokens exceed the threshold", async () => {
    const received: unknown[] = [];
    const client = fakeClient([
      toolUseWithLargeUsage(),
      summaryTurn("dense summary"),
      finalTextTurn()
    ]);
    const loop = makeLoopWithTools(client, received, 200, [echoTool]);
    await loop.runTurn("review the codebase", new AbortController().signal);
    expect(JSON.stringify(loop.messages)).toContain("Summary of prior conversation");
  });
});
