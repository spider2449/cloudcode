import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scripted fake client, same shape as tests/engine-loop.test.ts.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    async *create() {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

const toolUseTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

const textTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

const echoTool = {
  name: "EchoTool",
  description: "echoes",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute(input: Record<string, unknown>) {
    return { content: `echo:${JSON.stringify(input)}` };
  }
};

describe("EngineLoop knobs", () => {
  it("honors a custom maxTurns cap and reports the limit", async () => {
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client: fakeClient(Array(6).fill(0).map(() => toolUseTurn())),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-mt-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true,
      maxTurns: 3
    });
    await loop.runTurn("go", new AbortController().signal);
    const texts = received
      .filter(m => (m as { type?: string }).type === "assistant")
      .flatMap(m => (m as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message.content)
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("\n");
    expect(texts).toContain("[Stopped after 3 tool-use turns without a final answer]");
  });

  it("exposes model, permission mode, and effort through getters", () => {
    const loop = new EngineLoop({
      client: fakeClient([]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [],
      cwd: process.cwd(),
      permissionMode: "acceptEdits",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-g-"))),
      onMessage: () => {},
      requestPermission: async () => true,
      effort: "high"
    });
    loop.setPermissionMode("default");
    loop.setEffort("low");
    loop.setModel("other-model");
    expect(loop.getModel()).toBe("other-model");
    expect(loop.getPermissionMode()).toBe("default");
    expect(loop.getEffort()).toBe("low");
  });
});

describe("EngineLoop hooks", () => {
  const blockingGuard = (blocked: boolean) => ({
    guard: async () => ({ blocked, reason: blocked ? "policy says no" : undefined }),
    observe: async () => {}
  });

  it("a blocked PreToolUse becomes an error tool_result and the turn continues", async () => {
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("gave up cleanly")]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-hb-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true,
      hooks: blockingGuard(true)
    });
    await loop.runTurn("go", new AbortController().signal);
    const toolResults = received.filter(m => (m as { type?: string }).type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { content: string }).content).toContain("Blocked by PreToolUse hook");
    expect((toolResults[0] as { is_error: boolean }).is_error).toBe(true);
  });

  it("an allowed guard lets the tool run and observes PostToolUse and Stop", async () => {
    const seenEvents: string[] = [];
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("done")]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-ho-"))),
      onMessage: () => {},
      requestPermission: async () => true,
      hooks: {
        guard: async () => ({ blocked: false }),
        observe: async event => { seenEvents.push(event); }
      }
    });
    await loop.runTurn("go", new AbortController().signal);
    expect(seenEvents).toEqual(["PostToolUse", "Stop"]);
  });
});
