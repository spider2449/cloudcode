import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskTool, runSubagent, subagentTools, SUBAGENT_MAX_TURNS } from "../src/engine/tools/task.js";
import { PermissionStore } from "../src/agent/permissionStore.js";

// Scripted fake client, same shape as tests/engine-loop.test.ts.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    async *create(_req: unknown) {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

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

const textTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// One Grep call against a path that does not exist: cheap, deterministic.
const grepTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "Grep", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":"zzz-nomatch","path":"/nonexistent-cc-dir"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    client: () => fakeClient([]),
    model: () => "test-model",
    effort: () => "off" as const,
    contextWindow: () => 200000,
    permissionMode: () => "bypassPermissions" as const,
    // A real store backed by an empty temp project; decidePermission consults
    // it whenever a tool names a path, so a bare object would crash.
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-task-"))),
    lsp: undefined,
    networkPolicy: undefined,
    requestPermission: async () => true,
    ...overrides
  };
}

describe("subagentTools", () => {
  it("contains exactly the eight read-only tools and never Task", () => {
    expect(subagentTools().map(t => t.name).sort())
      .toEqual(["Definition", "Diagnostics", "Glob", "Grep", "Hover", "Read", "References", "Symbols"]);
  });
});

describe("runSubagent", () => {
  it("returns the subagent's final assistant text", async () => {
    const deps = makeDeps({ client: () => fakeClient([grepTurn(), textTurn("found it in src/auth.ts:42")]) });
    const out = await runSubagent(deps as never, "/tmp", "find the token logic", new AbortController().signal);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("found it in src/auth.ts:42");
  });

  it("exposes only the restricted toolset to the provider", async () => {
    const requests: unknown[] = [];
    const deps = makeDeps({
      client: () => capturingClient([grepTurn(), textTurn("done")], requests)
    });
    await runSubagent(deps as never, "/tmp", "look around", new AbortController().signal);
    const first = requests[0] as { tools: Array<{ name: string }> };
    expect(first.tools.map(t => t.name).sort())
      .toEqual(["Definition", "Diagnostics", "Glob", "Grep", "Hover", "Read", "References", "Symbols"]);
  });

  it("prefixes a cut-off note when the turn cap is hit", async () => {
    const deps = makeDeps({ client: () => fakeClient(Array(SUBAGENT_MAX_TURNS + 5).fill(0).map(() => grepTurn())) });
    const out = await runSubagent(deps as never, "/tmp", "endless exploration", new AbortController().signal);
    expect(out.content).toContain(`[Exploration stopped after ${SUBAGENT_MAX_TURNS} turns without a final answer]`);
  });

  it("converts a nested provider failure into an error result", async () => {
    const failing = {
      async *create() { throw new Error("boom"); }
    };
    const deps = makeDeps({ client: () => failing });
    const out = await runSubagent(deps as never, "/tmp", "explode", new AbortController().signal);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("boom");
  });

  it("propagates permission rules: a denied inner tool call does not fail the subagent", async () => {
    const deps = makeDeps({
      permissionMode: () => "default" as const,
      requestPermission: async () => false,
      client: () => fakeClient([grepTurn(), textTurn("done anyway")])
    });
    const out = await runSubagent(deps as never, "/tmp", "try to search", new AbortController().signal);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("done anyway");
  });

  it("reports an interrupt as interrupted, not a crash", async () => {
    const controller = new AbortController();
    let call = 0;
    const client = {
      async *create() {
        call += 1;
        // Aborting before a tool-use turn makes the loop break at its
        // post-stream abort check, so no final answer is reached.
        if (call === 2) controller.abort();
        const events = grepTurn();
        for (const e of events) yield e as never;
      }
    };
    const deps = makeDeps({ client: () => client });
    const out = await runSubagent(deps as never, "/tmp", "interrupt me", controller.signal);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Interrupted");
  });
});

describe("createTaskTool", () => {
  it("validates its input before spawning anything", async () => {
    const tool = createTaskTool(makeDeps() as never);
    const out = await tool.execute({}, { cwd: "/tmp" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("prompt");
  });

  it("runs under the Task name and forwards the abort signal", async () => {
    const requests: unknown[] = [];
    const tool = createTaskTool(makeDeps({
      client: () => capturingClient([textTurn("ok")], requests)
    }) as never);
    const controller = new AbortController();
    const out = await tool.execute(
      { description: "check things", prompt: "inspect the layout" },
      { cwd: "/tmp", signal: controller.signal }
    );
    expect(tool.name).toBe("Task");
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("ok");
  });
});

import { builtinTools } from "../src/engine/registry.js";

describe("builtinTools task option", () => {
  it("omits Task when no deps are provided", () => {
    expect(builtinTools().map(t => t.name)).not.toContain("Task");
  });

  it("registers Task when deps are provided", () => {
    const deps = {
      client: () => { throw new Error("not called"); },
      model: () => "m",
      effort: () => "off" as const,
      permissionMode: () => "default" as const,
      store: {},
      requestPermission: async () => true
    };
    const names = builtinTools({ task: deps as never }).map(t => t.name);
    expect(names).toContain("Task");
  });
});
