import { describe, it, expect, vi } from "vitest";
import { AgentSession } from "../src/agent/session.js";

function fakeQuery(received: unknown[]) {
  // Mimics the SDK: consumes the prompt stream, echoes canned messages.
  return (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const m of args.prompt) {
        received.push(m);
        yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
      }
    })();
    return Object.assign(gen, {
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn()
    });
  };
}

describe("AgentSession", () => {
  it("emits session id and forwards messages for sent text", async () => {
    const received: unknown[] = [];
    const messages: unknown[] = [];
    let sessionId = "";
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: m => messages.push(m),
      onPermissionRequest: () => {},
      onSessionId: id => { sessionId = id; },
      queryFn: fakeQuery(received) as never
    });
    session.start();
    session.send("hello");
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2));
    expect(sessionId).toBe("sess-1");
    expect((received[0] as { message: { content: string } }).message.content).toBe("hello");
    await session.dispose();
  });

  it("resolves canUseTool through onPermissionRequest", async () => {
    let captured: ((toolName: string, input: object) => Promise<unknown>) | undefined;
    const queryFn = (args: { options: { canUseTool: typeof captured } }) => {
      captured = args.options.canUseTool;
      const gen = (async function* () {})();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: req => req.resolve(true),
      onSessionId: () => {},
      queryFn: queryFn as never
    });
    session.start();
    const result = await captured!("Bash", { command: "ls" });
    expect(result).toMatchObject({ behavior: "allow" });
    await session.dispose();
  });
});
