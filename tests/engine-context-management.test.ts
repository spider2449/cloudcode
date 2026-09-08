import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const textTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

describe("context management request shape", () => {
  it("sends betas + clear_tool_uses edit by default", async () => {
    const requests: unknown[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "cc-"));
    const loop = new EngineLoop({
      client: capturingClient([textTurn()], requests) as never,
      model: "claude-sonnet-4-5",
      systemPrompt: "sys",
      tools: [],
      cwd,
      permissionMode: "bypassPermissions",
      store: new PermissionStore(cwd),
      onMessage: () => {},
      requestPermission: async () => true,
    });
    await loop.runTurn("hello", new AbortController().signal);
    const req = requests[0] as Record<string, unknown>;
    expect(req.betas).toEqual(["context-management-2025-06-27"]);
    const cm = req.context_management as { edits: Array<Record<string, unknown>> };
    expect(cm.edits[0]).toMatchObject({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 100_000 },
      keep: { type: "tool_uses", value: 3 },
    });
  });

  it("opt-out with contextManagement: false sends neither field", async () => {
    const requests: unknown[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "cc-"));
    const loop = new EngineLoop({
      client: capturingClient([textTurn()], requests) as never,
      model: "claude-sonnet-4-5",
      systemPrompt: "sys",
      tools: [],
      cwd,
      permissionMode: "bypassPermissions",
      store: new PermissionStore(cwd),
      contextManagement: false,
      onMessage: () => {},
      requestPermission: async () => true,
    });
    await loop.runTurn("hello", new AbortController().signal);
    const req = requests[0] as Record<string, unknown>;
    expect(req.betas).toBeUndefined();
    expect(req.context_management).toBeUndefined();
  });
});
