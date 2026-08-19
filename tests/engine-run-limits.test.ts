import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineLoop } from "../src/engine/loop.js";
import { RunLimitError } from "../src/engine/runLimits.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import type { ToolDef } from "../src/engine/tools/types.js";

const tool: ToolDef = {
  name: "EchoTool", description: "echo", input_schema: { type: "object" },
  async execute() { return { content: "ran" }; }
};
const toolTurn = () => [
  { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "EchoTool" } },
  { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop" },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } }
];
const textTurn = () => [
  { type: "content_block_start", content_block: { type: "text" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop" },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } }
];

function client(turns: object[][]) {
  const remaining = [...turns];
  return { async *create() { for (const event of remaining.shift() ?? []) yield event as never; } };
}

function loop(options: {
  turns: object[][]; received: unknown[]; tools?: ToolDef[]; model?: string;
  limits: { maxTurns?: number; timeoutMs?: number; maxCostUsd?: number };
}) {
  return new EngineLoop({
    client: client(options.turns), model: options.model ?? "test-model", systemPrompt: "s",
    tools: options.tools ?? [tool], cwd: process.cwd(), permissionMode: "bypassPermissions",
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-engine-limits-"))), runLimits: options.limits,
    onMessage: message => options.received.push(message), requestPermission: async () => true
  });
}

describe("EngineLoop run limits", () => {
  it("stops at maxTurns before tool execution or a continuation request", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const received: unknown[] = [];
    const engine = loop({ turns: [toolTurn(), textTurn()], received, tools: [{ ...tool, execute }], limits: { maxTurns: 1 } });
    await engine.runTurn("go", new AbortController().signal);
    expect(execute).not.toHaveBeenCalled();
    expect(received).toContainEqual({ type: "limit", limit: "maxTurns", value: 1 });
    expect(received.at(-1)).toMatchObject({ finish_reason: "limit" });
  });

  it("aggregates usage across provider requests", async () => {
    const received: unknown[] = [];
    await loop({ turns: [toolTurn(), textTurn()], received, limits: {} })
      .runTurn("go", new AbortController().signal);
    expect(received.at(-1)).toMatchObject({ usage: { input_tokens: 20, output_tokens: 10 } });
  });

  it("stops before tool execution when a known-model cost cap is reached", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const received: unknown[] = [];
    const engine = loop({
      turns: [toolTurn()], received, tools: [{ ...tool, execute }], model: "claude-sonnet-5",
      limits: { maxCostUsd: 0.000001 }
    });
    await engine.runTurn("go", new AbortController().signal);
    expect(execute).not.toHaveBeenCalled();
    expect(received).toContainEqual({ type: "limit", limit: "maxCostUsd", value: 0.000001 });
  });

  it("reports a timeout abort as a limit", async () => {
    const controller = new AbortController();
    const received: unknown[] = [];
    const engine = new EngineLoop({
      client: {
        // oxlint-disable-next-line require-yield -- waits for abort then throws
        async *create(_request, signal) {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        }
      },
      model: "test-model", systemPrompt: "s", tools: [], cwd: process.cwd(), permissionMode: "default",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-engine-timeout-"))), runLimits: { timeoutMs: 10 },
      onMessage: message => received.push(message), requestPermission: async () => true
    });
    setTimeout(() => controller.abort(new RunLimitError("timeoutMs", 10)), 10);
    await engine.runTurn("go", controller.signal);
    expect(received).toContainEqual({ type: "limit", limit: "timeoutMs", value: 10 });
    expect(received.at(-1)).toMatchObject({ finish_reason: "limit" });
  });
});
