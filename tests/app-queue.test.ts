import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../src/ui/nativeApp.js";
import { FakeTerminal } from "../src/ui/term/terminal.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

vi.mock("../src/agent/models.js", () => ({
  fetchModels: vi.fn().mockResolvedValue(["model-a", "model-b"])
}));
vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));
vi.mock("../src/agent/mcp.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/mcp.js")>("../src/agent/mcp.js");
  // Keep tests hermetic: never read the developer's real ~/.cloudcode/mcp.json.
  return { ...actual, loadMcpServers: vi.fn().mockReturnValue({}) };
});

import { makeClient } from "../src/engine/api.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

// A client whose first turn stalls mid-stream until release() is called, so
// tests can submit input while the app is verifiably in the streaming phase.
// Later turns pass through the already-resolved gate immediately.
function gatedClient() {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const client = {
    create: vi.fn(async function* () {
      yield { type: "content_block_start", content_block: { type: "text" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "working" } };
      await gate;
      yield { type: "content_block_stop" };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
    })
  };
  return { client, release: () => release() };
}

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
});

function makeApp() {
  const { client, release } = gatedClient();
  vi.mocked(makeClient).mockReturnValue(client as never);
  const terminal = new FakeTerminal({ rows: 24, columns: 80 });
  const app = new App({
    cwd: "/repo",
    providers: { anthropic: {} },
    initialProvider: "anthropic",
    sessionIndex: new SessionIndex()
  }, terminal);
  return { app, terminal, release, client };
}

describe("App input queue", () => {
  it("queues a message submitted while streaming and shows a queued row", async () => {
    const { app, terminal } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.submitForTest("second");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("queued: second");
    // Not yet sent as a user message.
    expect(terminal.writes.join("")).not.toContain("> second");
  });

  it("drains queued messages FIFO when the turn completes", async () => {
    const { app, terminal, release, client } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.submitForTest("second");
    app.submitForTest("third");
    await wait();
    release();
    await wait(80);
    const all = terminal.writes.join("");
    expect(all).toContain("> second");
    expect(all).toContain("> third");
    expect(all.indexOf("> second")).toBeLessThan(all.indexOf("> third"));
    // One send per message: first + second + third.
    expect(client.create).toHaveBeenCalledTimes(3);
  });

  it("typing while streaming updates the input box", async () => {
    const { app, terminal } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.handleKey({ t: "printable", ch: "z" });
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("> z█");
  });
});
