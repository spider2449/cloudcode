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

describe("EngineLoop image plumbing", () => {
  it("tool outputs with images become block-array tool_results", async () => {
    const received: unknown[] = [];
    const imageTool = {
      name: "EchoTool",
      description: "echoes",
      input_schema: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: "[image: x.png]", images: [{ mediaType: "image/png", base64: "aGk=" }] })
    };
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("seen")]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [imageTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-img-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true
    });
    await loop.runTurn("look", new AbortController().signal);
    const results = received.filter(m => (m as { type?: string }).type === "tool_result");
    expect((results[0] as { content: unknown }).content).toEqual([
      { type: "text", text: "[image: x.png]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }
    ]);
  });

  it("attached images turn the user message into blocks with the image first", async () => {
    const requests: unknown[] = [];
    const client = {
      async *create(req: unknown) { requests.push(req); for (const e of [textTurn("ok")]) yield e as never; }
    };
    const loop = new EngineLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      tools: [],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-imgu-"))),
      onMessage: () => {},
      requestPermission: async () => true
    });
    await loop.runTurn("what is this", new AbortController().signal, [
      { mediaType: "image/png", base64: "aGk=" }
    ]);
    const req = requests[0] as { messages: Array<{ role: string; content: unknown }> };
    const lastUser = [...req.messages].reverse().find(m => m.role === "user");
    if (!lastUser) throw new Error("no user message");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const content = lastUser.content as Array<{ type: string; source?: { media_type: string }; text?: string }>;
    expect(content[0].type).toBe("image");
    expect(content[0].source?.media_type).toBe("image/png");
    expect(content[1].type).toBe("text");
    expect(content[1].text).toBe("what is this");
  });
});
