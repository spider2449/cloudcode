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

// A single turn issuing two separate tool calls, each with its own clean
// content_block_start/delta/stop sequence.
const twoToolUseTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_a", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_b", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"y\":2}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// Some non-Anthropic providers drop or reorder content_block_stop events.
// Two tool_use blocks back to back where the first's stop event never
// arrives - the loop must still recover the first block's input instead of
// silently discarding it when the second block starts.
const parallelToolUseTurnMissingFirstStop = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  // no content_block_stop for index 0
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"y\":2}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// A tool_use block that is the last content block in the stream, whose
// content_block_stop is missing entirely (stream ends right after the delta).
const toolUseTurnMissingTrailingStop = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// Captures each request passed to create() so tests can assert on the
// thinking parameter and max_tokens.
function capturingClient(turns: object[][], requests: unknown[]) {
  let call = 0;
  return {
    async *create(req: unknown) {
      requests.push(req);
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

const thinkingTurn = (thinking: string, text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
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

  it("interleaves each tool's onMessage emissions with its own result, for a turn with 2+ tool calls", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([twoToolUseTurn(), textTurn("done")], received);
    await loop.runTurn("go", new AbortController().signal);
    // Reduce the onMessage stream to a sequence of tags identifying each
    // tool_use block (by id) and each tool_result (by tool_use_id), in the
    // order onMessage was called.
    const tags = received
      .map(m => {
        const rec = m as Record<string, unknown>;
        if (rec.type === "assistant") {
          const content = (rec.message as { content: Array<Record<string, unknown>> }).content;
          if (content.length === 1 && content[0].type === "tool_use") return `tool:${content[0].id}`;
          return undefined;
        }
        if (rec.type === "tool_result") return `result:${rec.tool_use_id}`;
        return undefined;
      })
      .filter((t): t is string => t !== undefined);
    // Each tool's label must be immediately followed by its own result,
    // before the next tool's label appears.
    expect(tags).toEqual(["tool:tu_a", "result:tu_a", "tool:tu_b", "result:tu_b"]);
  });

  it("recovers a tool_use block's input when its content_block_stop is dropped by the provider", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([parallelToolUseTurnMissingFirstStop(), textTurn("done")], received);
    await loop.runTurn("go", new AbortController().signal);
    const flat = JSON.stringify(loop.messages);
    // Both tool calls' real input must have been executed, not the {} placeholder.
    expect(flat).toContain("echo:{\\\"x\\\":1}");
    expect(flat).toContain("echo:{\\\"y\\\":2}");
  });

  it("recovers the final tool_use block's input when the stream ends without a trailing content_block_stop", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([toolUseTurnMissingTrailingStop(), textTurn("done")], received);
    await loop.runTurn("go", new AbortController().signal);
    const flat = JSON.stringify(loop.messages);
    expect(flat).toContain("echo:{\\\"x\\\":1}");
  });

  it("compact() returns an estimated token count reflecting the shrunk history", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([textTurn("a fairly long assistant reply about several topics".repeat(10))], received);
    await loop.runTurn("go", new AbortController().signal);
    const beforeEstimate = JSON.stringify(loop.messages).length / 4;
    const compactClient = {
      async *create() {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "short recap" } };
        yield { type: "message_stop" };
      }
    };
    const estimate = await loop.compact(compactClient as never, "m");
    expect(estimate).toBeLessThan(beforeEstimate);
  });

  it("passes the abort signal to tools and skips remaining tools after abort", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const ran: string[] = [];
    const tools: ToolDef[] = [
      {
        name: "SlowTool",
        description: "",
        input_schema: { type: "object", properties: {}, required: [] },
        async execute(_input, ctx) {
          seenSignals.push(ctx.signal);
          ran.push("SlowTool");
          controller.abort(); // simulate Esc while the tool is running
          return { content: "done" };
        }
      },
      {
        name: "SecondTool",
        description: "",
        input_schema: { type: "object", properties: {}, required: [] },
        async execute() {
          ran.push("SecondTool");
          return { content: "should not run" };
        }
      }
    ];
    // Fake client: first response requests both tools, then the aborted
    // follow-up request throws (matching real SDK behavior on abort).
    const client = {
      async *create(_req: unknown, signal: AbortSignal) {
        if (signal.aborted) throw new Error("aborted");
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "SlowTool", input: {} } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "SecondTool", input: {} } };
        yield { type: "content_block_stop", index: 1 };
        yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
      }
    };
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client,
      model: "m",
      systemPrompt: "s",
      tools,
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-abort-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true
    });
    await loop.runTurn("go", controller.signal);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(ran).toEqual(["SlowTool"]); // SecondTool skipped after abort
    // Both tool_use ids still received tool_result entries (API invariant).
    const resultsMsg = loop.messages.find(
      m => (m as { role?: string; content?: unknown[] }).role === "user" && Array.isArray((m as { content?: unknown[] }).content)
        && ((m as { content?: unknown[] }).content ?? []).some((c: unknown) => (c as { type?: string }).type === "tool_result")
    ) as { content: Array<{ tool_use_id: string; content: string }> };
    expect(resultsMsg.content.map(r => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(resultsMsg.content[1].content).toContain("Interrupted");
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

describe("EngineLoop thinking", () => {
  function makeEffortLoop(turns: object[][], received: unknown[], requests: unknown[], effort: "off" | "low" | "medium" | "high") {
    return new EngineLoop({
      client: capturingClient(turns, requests),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-"))),
      effort,
      onMessage: m => received.push(m),
      requestPermission: async () => true
    });
  }

  it("omits thinking param when effort is off", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("hi")], [], requests, "off");
    await loop.runTurn("q", new AbortController().signal);
    const req = requests[0] as { thinking?: unknown; max_tokens: number };
    expect(req.thinking).toBeUndefined();
    expect(req.max_tokens).toBe(8192);
  });

  it("sends thinking budget and raised max_tokens when effort is medium", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("hi")], [], requests, "medium");
    await loop.runTurn("q", new AbortController().signal);
    const req = requests[0] as { thinking?: unknown; max_tokens: number };
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(req.max_tokens).toBe(16384 + 8192);
  });

  it("setEffort applies to the next request", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("a"), textTurn("b")], [], requests, "off");
    await loop.runTurn("q1", new AbortController().signal);
    loop.setEffort("high");
    await loop.runTurn("q2", new AbortController().signal);
    expect((requests[1] as { thinking?: unknown }).thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
  });

  it("accumulates thinking blocks with signature into history and emits thinking deltas", async () => {
    const received: unknown[] = [];
    const requests: unknown[] = [];
    const loop = makeEffortLoop([thinkingTurn("let me think", "answer")], received, requests, "low");
    await loop.runTurn("q", new AbortController().signal);
    const assistant = loop.messages[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "let me think", signature: "sig123" });
    expect(assistant.content[1]).toEqual({ type: "text", text: "answer" });
    const thinkingMsgs = received.filter(m =>
      (m as { event?: { delta?: { type?: string } } }).event?.delta?.type === "thinking_delta");
    expect(thinkingMsgs).toHaveLength(1);
  });
});

describe("EngineLoop.setSystemPrompt", () => {
  it("setSystemPrompt changes the system text sent on the next turn", async () => {
    const requests: unknown[] = [];
    const loop = new EngineLoop({
      client: capturingClient([textTurn("hi"), textTurn("bye")], requests),
      model: "test-model",
      systemPrompt: "old prompt",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-"))),
      onMessage: () => {},
      requestPermission: async () => true
    });
    // First turn should use the initial system prompt
    await loop.runTurn("hi", new AbortController().signal);
    const firstReq = requests[0] as { system: Array<{ text: string }> };
    expect(firstReq.system[0].text).toBe("old prompt");

    // Now change the system prompt
    loop.setSystemPrompt("new prompt");

    // Second turn should use the new system prompt
    await loop.runTurn("bye", new AbortController().signal);
    const secondReq = requests[1] as { system: Array<{ text: string }> };
    expect(secondReq.system[0].text).toBe("new prompt");
  });
});
