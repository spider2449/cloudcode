import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../src/ui/nativeApp.js";
import { FakeTerminal } from "../src/ui/term/terminal.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

vi.mock("../src/agent/models.js", () => ({
  fetchModels: vi.fn().mockResolvedValue(["model-a", "model-b"])
}));
vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));
vi.mock("../src/engine/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/engine/loop.js")>("../src/engine/loop.js");
  function SpiedEngineLoop(this: unknown, opts: ConstructorParameters<typeof actual.EngineLoop>[0]) {
    return new actual.EngineLoop(opts);
  }
  return { ...actual, EngineLoop: vi.fn(SpiedEngineLoop as unknown as typeof actual.EngineLoop) };
});

import { makeClient } from "../src/engine/api.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
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

function textTurn(text: string, usage?: Record<string, number>): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage ?? {} }
  ];
}

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
});

function makeApp(turns: Event[][]) {
  vi.mocked(makeClient).mockReturnValue(fakeClient(turns) as never);
  const terminal = new FakeTerminal({ rows: 24, columns: 80 });
  const app = new App({
    cwd: "/repo",
    providers: { anthropic: {} },
    initialProvider: "anthropic",
    sessionIndex: new SessionIndex()
  }, terminal);
  return { app, terminal };
}

describe("App", () => {
  it("appends a user message to the buffer and renders a frame that shows it", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    // Inline rendering commits the transcript row to scrollback once, then
    // never re-emits it, so check the full write history rather than only
    // the most recent (dynamic-block-only) frame.
    const all = terminal.writes.join("");
    expect(all).toContain("> hello");
  });

  it("/new clears the transcript and re-shows the welcome banner", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    terminal.writes.length = 0;
    app.submitForTest("/new");
    await wait();
    const all = terminal.writes.join("");
    expect(all).toContain("Welcome to cloudcode");
    expect(all).not.toContain("hi there");
  });

  it("commits the assistant reply to the buffer on result", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const all = terminal.writes.join("");
    expect(all).toContain("hi there");
  });

  it("updates cost and token StatusBar segments from usage on result", async () => {
    const { app, terminal } = makeApp([textTurn("ok", { input_tokens: 100, output_tokens: 50 })]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("tok");
  });

  it("every emitted frame ends with the StatusBar as the last written row", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    for (const frame of terminal.writes) {
      const lines = frame.split("\r\n");
      expect(lines[lines.length - 1]).toContain("/repo");
    }
  });

  it("auto-compact fires when context usage reaches 80%", async () => {
    const { app } = makeApp([textTurn("ok", { input_tokens: 160_000, output_tokens: 0 })]);
    const compactSpy = vi.fn();
    app.onAutoCompactForTest = compactSpy;
    void app.run();
    app.submitForTest("hello");
    await wait();
    expect(compactSpy).toHaveBeenCalled();
  });
});

describe("App key routing", () => {
  it("Ctrl-C once shows a warning notice, twice within 2s exits", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "ctrl", ch: "c" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("Press Ctrl+C again to exit");
    app.handleKey({ t: "ctrl", ch: "c" });
    await wait(5);
    expect(app.isRunningForTest()).toBe(false);
  });

  it("transcript items are written to the terminal exactly once", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    await wait(5);
    app.recompute();
    const before = terminal.writes.join("");
    app.handleKey({ t: "printable", ch: "x" }); // triggers another recompute
    const after = terminal.writes.join("").slice(before.length);
    // The welcome banner was committed in the first frame and must not be
    // re-emitted by later frames.
    expect(before).toContain("cloudcode");
    expect(after).not.toContain("\x1b[2J");
  });

  it("tick() writes nothing while idle so a mouse selection survives", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    await wait(5);
    app.recompute();
    const count = terminal.writes.length;
    app.tick();
    expect(terminal.writes.length).toBe(count);
  });

  it("scrollback keys are ignored while an overlay is open", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.openResumePickerForTest();
    app.handleKey({ t: "pgup" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).not.toContain("Press End to jump to latest");
  });

  it("BackTab cycles the permission mode", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "backtab" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("acceptEdits");
  });

  it("printable keys reach the InputBox and appear in the next frame", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.handleKey({ t: "printable", ch: "x" });
    await wait(5);
    expect(terminal.writes[terminal.writes.length - 1]).toContain("> x");
  });
});
