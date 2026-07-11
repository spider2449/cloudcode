import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef } from "../src/engine/tools/types.js";

// Scripted fake: each call to create() yields the next scripted event array.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    async *create() {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

const echoTool: ToolDef = {
  name: "EchoTool",
  description: "echoes",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute(input) {
    return { content: `echo:${JSON.stringify(input)}` };
  }
};

const textTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// Mirrors the real Anthropic streaming protocol: input_tokens (and cache
// fields) arrive on message_start, while message_delta only ever carries
// output_tokens.
const textTurnWithMessageStart = (text: string, inputTokens: number) => [
  { type: "message_start", message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
];

const toolUseTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

function makeLoop(turns: object[][], received: unknown[]) {
  return new EngineLoop({
    client: fakeClient(turns),
    model: "test-model",
    systemPrompt: "sys",
    tools: [echoTool],
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-"))),
    onMessage: m => received.push(m),
    requestPermission: async () => true
  });
}

describe("EngineLoop", () => {
  it("streams text and emits assistant + success result", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([textTurn("hello")], received);
    await loop.runTurn("hi", new AbortController().signal);
    const types = received.map(m => (m as { type: string }).type);
    expect(types).toContain("stream_event");
    expect(types).toContain("assistant");
    const result = received.find(m => (m as { type: string }).type === "result") as { subtype: string };
    expect(result.subtype).toBe("success");
  });

  it("captures input_tokens from message_start and merges with message_delta output_tokens", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([textTurnWithMessageStart("hi", 42)], received);
    await loop.runTurn("hi", new AbortController().signal);
    const result = received.find(m => (m as { type: string }).type === "result") as {
      usage?: { input_tokens?: number; output_tokens?: number };
      total_cost_usd?: number;
    };
    expect(result.usage?.input_tokens).toBe(42);
    expect(result.usage?.output_tokens).toBe(5);
  });

  it("executes a tool call and continues to the next API turn", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([toolUseTurn(), textTurn("done")], received);
    await loop.runTurn("go", new AbortController().signal);
    const assistants = received.filter(m => (m as { type: string }).type === "assistant");
    expect(assistants.length).toBe(2); // tool_use turn + final text turn
    // History must contain the tool_result the second call consumed.
    const flat = JSON.stringify(loop.messages);
    expect(flat).toContain("tool_result");
    // Note: content is `echo:${JSON.stringify(input)}` and gets JSON.stringify'd again
    // when serializing loop.messages, so inner quotes are escaped in the flattened string.
    expect(flat).toContain("echo:{\\\"x\\\":1}");
  });

  it("denied permission produces an error tool_result and still continues", async () => {
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("ok")]) as never,
      model: "m",
      systemPrompt: "s",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "default",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop2-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => false
    });
    await loop.runTurn("go", new AbortController().signal);
    expect(JSON.stringify(loop.messages)).toContain("User denied");
  });
});
