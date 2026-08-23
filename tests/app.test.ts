import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
vi.mock("../src/engine/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/engine/loop.js")>("../src/engine/loop.js");
  function SpiedEngineLoop(this: unknown, opts: ConstructorParameters<typeof actual.EngineLoop>[0]) {
    return new actual.EngineLoop(opts);
  }
  return { ...actual, EngineLoop: vi.fn(SpiedEngineLoop as unknown as typeof actual.EngineLoop) };
});
vi.mock("../src/agent/settings.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/agent/settings.js")>()),
  // Keep tests hermetic: never touch the developer's real ~/.cloudcode.
  loadSettings: vi.fn().mockReturnValue({}),
  saveSetting: vi.fn()
}));

import { makeClient } from "../src/engine/api.js";
import { loadMcpServers } from "../src/agent/mcp.js";
import { saveSetting } from "../src/agent/settings.js";

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
  vi.mocked(loadMcpServers).mockClear();
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
  it("does not load project executable configuration before startup trust is denied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-trust-"));
    try {
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "never-run-this-command" } } }));
      vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]) as never);
      const terminal = new FakeTerminal({ rows: 24, columns: 80 });
      const app = new App({ cwd, providers: { anthropic: {} }, initialProvider: "anthropic", sessionIndex: new SessionIndex() }, terminal);
      const running = app.run();
      await wait(5);
      expect(terminal.writes.join("")).toContain("Project configuration requests permission");
      expect(loadMcpServers).not.toHaveBeenCalled();
      app.handleKey({ t: "printable", ch: "n" });
      await wait(5);
      expect(loadMcpServers).toHaveBeenCalledWith(cwd, undefined, false);
      app.submitForTest("/exit");
      await running;
    } finally {
      // GitStatusPoller may still have a just-spawned git process whose cwd is
      // this directory; Windows keeps that directory locked until it exits.
      await wait(200);
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  it("renders its synthetic input marker independently of the native caret", () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    app.recompute();
    const frame = terminal.writes[terminal.writes.length - 1];
    expect(frame).toContain("> █");
  });

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

  it("warns on a nonexistent @path but still sends the message", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.submitForTest("look at @definitely-missing-file.ts");
    await wait();
    const all = terminal.writes.join("");
    expect(all).toContain("does not exist");
    expect(all).toContain("> look at @definitely-missing-file.ts");
  });

  it("updates cost and token StatusBar segments from usage on result", async () => {
    const { app, terminal } = makeApp([textTurn("ok", { input_tokens: 100, output_tokens: 50 })]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("tok");
  });

  it("/statusline toggle persists statusLineItems through saveSetting", async () => {
    vi.mocked(saveSetting).mockClear();
    const { app } = makeApp([textTurn("ok")]);
    void app.run();
    await wait();
    app.submitForTest("/statusline");
    await wait();
    app.handleKey({ t: "down" }); // cursor onto "Served model override"
    app.handleKey({ t: "enter" }); // enable it -> persists immediately
    const call = vi.mocked(saveSetting).mock.calls.find(c => c[0] === "statusLineItems");
    expect(call).toBeDefined();
    const value = call?.[1];
    expect(Array.isArray(value) && value.includes("servedModel")).toBe(true);
  });

  it("every emitted frame ends with the StatusBar as the last written row", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    for (const frame of terminal.writes) {
      const lines = frame.split("\r\n");
      // The default status bar shows provider/model and permission mode.
      expect(lines[lines.length - 1]).toContain("default");
    }
  });

  it("/mcp renders its output without requiring further input", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    // Let the startup repaints (initial frame + 50ms settle repaint) finish
    // first so only the command itself can put its output on screen.
    await wait(80);
    terminal.writes.length = 0;
    app.submitForTest("/mcp");
    await wait();
    const all = terminal.writes.join("");
    expect(all).toContain("No MCP servers configured");
  });

  it("/new resets the status-bar context usage so it doesn't outlive its session", async () => {
    // 100k of the 200k default window = 50%. After /new the fresh, empty
    // session has no usage, so the status bar must not keep advertising 50%
    // (which would disagree with what /context reports for the new session).
    const { app, terminal } = makeApp([textTurn("ok", { input_tokens: 100_000, output_tokens: 0 })]);
    void app.run();
    app.submitForTest("hello");
    await wait();
    expect(terminal.writes[terminal.writes.length - 1]).toContain("(50%)");
    app.submitForTest("/new");
    await wait();
    expect(terminal.writes[terminal.writes.length - 1]).not.toContain("(50%)");
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

describe("App resize handling", () => {
  it("clears the screen and re-commits the full transcript after a width resize", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait(80);
    terminal.writes.length = 0;
    terminal.resize({ rows: 24, columns: 60 });
    await wait(250);
    const all = terminal.writes.join("");
    // The terminal reflows once-committed rows on width change, so the app
    // must repaint from scratch: clear, then re-lay-out every transcript item
    // at the new width.
    expect(all).toContain("\x1b[2J");
    // The re-committed transcript scrolls into native scrollback where the
    // pre-resize copy still lives; without ESC[3J every width resize stacks
    // one more duplicate transcript in scrollback.
    expect(all).toContain("\x1b[3J");
    expect(all).toContain("> hello");
    expect(all).toContain("hi there");
  });

  it("a height-only resize also gets the debounced full clear+reprint (stale footer copies bake into scrollback when the window shrinks)", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait(80);
    terminal.writes.length = 0;
    // When a terminal window gets shorter, the host pushes the viewport
    // top -- including previously painted footer rows -- into scrollback,
    // where no escape sequence can erase them. Only the scrollback-clearing
    // full reprint cleans those baked copies, so it must fire for height
    // changes too, not just width changes.
    terminal.resize({ rows: 30, columns: 80 });
    await wait(250);
    const all = terminal.writes.join("");
    expect(all).toContain("\x1b[3J");
    expect(all).toContain("> hello"); // transcript re-committed, not lost
    expect(all).toContain("anthropic · default"); // status bar repainted
  });

  it("a resize storm coalesces into a single full repaint", async () => {
    const { app, terminal } = makeApp([textTurn("hi there")]);
    void app.run();
    app.submitForTest("hello");
    await wait(80);
    terminal.writes.length = 0;
    terminal.resize({ rows: 24, columns: 70 });
    terminal.resize({ rows: 24, columns: 65 });
    terminal.resize({ rows: 24, columns: 60 });
    await wait(300);
    const all = terminal.writes.join("");
    const clears = all.split("\x1b[2J").length - 1;
    expect(clears).toBe(1);
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

  it("keys are routed to the overlay, not the input box, while an overlay is open", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    app.openResumePickerForTest();
    app.handleKey({ t: "pgup" });
    await wait(5);
    const last = terminal.writes[terminal.writes.length - 1];
    // The overlay must still be rendered (pgup did not close or bypass it)...
    expect(last).toContain("Resume a session");
    // ...and pgup must not have reached the input box as typed content.
    expect(last).not.toContain("> pgup");
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
  it("a stopped App never writes to the terminal on a later resize (stale-instance guard)", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    await wait(5);
    app.submitForTest("/exit");
    await wait(5);
    expect(app.isRunningForTest()).toBe(false);
    terminal.writes.length = 0;
    // A dead App instance reacting to resize was the root cause of dueling
    // frames after a project switch: the old App cleared the screen and
    // painted its stale footer over the live App's output on every resize
    // tick. Once stopped, an App must be inert.
    terminal.resize({ rows: 30, columns: 80 });
    await wait(5);
    expect(terminal.writes).toEqual([]);
  });

  it("/exit does not repaint a fresh frame after stopping (the finally() callback must respect the stopped state)", async () => {
    const { app, terminal } = makeApp([textTurn("ok")]);
    void app.run();
    await wait(5);
    terminal.writes.length = 0;
    app.submitForTest("/exit");
    // /exit's run() calls ctx.exit() -> stop() synchronously, but the
    // .finally() attached to the command promise still fires on the next
    // microtask; without a running-state guard it repainted a brand-new
    // frame (fresh empty prompt, fresh elapsed timer) over the already
    // torn-down terminal.
    await wait(5);
    expect(app.isRunningForTest()).toBe(false);
    // finalize() writes exactly one reset sequence; nothing after it.
    expect(terminal.writes.length).toBe(1);
  });
});
