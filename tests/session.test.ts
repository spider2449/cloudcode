import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));

import { makeClient } from "../src/engine/api.js";
import { AgentSession, shouldExtract } from "../src/agent/session.js";

type Event = Record<string, unknown>;

function fakeClient(turns: Event[][]) {
  let call = 0;
  return {
    create: vi.fn(async function* () {
      const events = turns[Math.min(call, turns.length - 1)];
      call++;
      for (const e of events) yield e;
    })
  };
}

function textTurn(text: string): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }
  ];
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id, name } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }
  ];
}

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
});

describe("AgentSession", () => {
  it("emits session id and forwards messages for sent text", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const messages: unknown[] = [];
    let sessionId = "";
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: m => messages.push(m),
      onPermissionRequest: () => {},
      onSessionId: id => { sessionId = id; }
    });
    session.start();
    expect(sessionId).not.toBe("");
    session.send("hello");
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2));
    expect(session.sessionId).toBe(sessionId);
    const assistantMsg = messages.find(m => (m as { type: string }).type === "assistant") as
      | { message: { content: Array<{ type: string; text?: string }> } }
      | undefined;
    expect(assistantMsg?.message.content[0]).toMatchObject({ type: "text", text: "ok" });
    await session.dispose();
  });

  it("resolves tool calls through onPermissionRequest", async () => {
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([toolUseTurn("t1", "Bash", { command: "echo hi" }), textTurn("done")])
    );
    const requests: { toolName: string; input: Record<string, unknown> }[] = [];
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: req => {
        requests.push({ toolName: req.toolName, input: req.input });
        req.resolve(true);
      },
      onSessionId: () => {}
    });
    session.start();
    session.send("run it");
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1));
    expect(requests[0]).toMatchObject({ toolName: "Bash", input: { command: "echo hi" } });
    await session.dispose();
  });

  it("interrupt() aborts the in-flight turn without throwing", async () => {
    vi.mocked(makeClient).mockReturnValue({
      create: vi.fn(async function* (_req: unknown, signal: AbortSignal) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    });
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: () => {},
      onSessionId: () => {}
    });
    session.start();
    session.send("go");
    await expect(session.interrupt()).resolves.toBeUndefined();
  });

  it("mcpStatus returns [] (MCP wiring lands in a later task)", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: () => {},
      onSessionId: () => {}
    });
    session.start();
    expect(await session.mcpStatus()).toEqual([]);
    await session.dispose();
  });
});

describe("shouldExtract", () => {
  const dir = join("tmp-base", "projects", "x", "memory");

  it("runs extraction after a turn and skips when the main agent wrote memories", () => {
    const noWrites = [
      { role: "user", content: "I'm a data scientist" },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: "thanks" },
      { role: "assistant", content: [{ type: "text", text: "np" }] }
    ];
    expect(shouldExtract(noWrites, 0, dir)).toBe(true);
    const withWrite = [
      ...noWrites.slice(0, 3),
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(dir, "a.md") } }] }
    ];
    expect(shouldExtract(withWrite, 0, dir)).toBe(false);
    expect(shouldExtract(noWrites, 2, dir)).toBe(false); // fewer than MIN_NEW_MESSAGES since cursor
  });
});
