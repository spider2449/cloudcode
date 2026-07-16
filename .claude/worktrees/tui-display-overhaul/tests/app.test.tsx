import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { fetchModels } from "../src/agent/models.js";
import { AgentSession } from "../src/agent/session.js";

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
import { EngineLoop } from "../src/engine/loop.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

type Event = Record<string, unknown>;

// Builds a fake Anthropic streaming client. `turns` is a list of event
// sequences; each call to `create` (i.e. each engine round-trip) consumes
// the next turn, repeating the last one if `send` is called more times
// than there are turns configured.
function fakeClient(turns: Event[][] | (() => AsyncGenerator<Event>)) {
  if (typeof turns === "function") {
    return { create: vi.fn(() => turns()) };
  }
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
  vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello from model")]));
  vi.mocked(EngineLoop).mockClear();
});

function makeApp() {
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  return render(
    <App
      cwd="/p"
      providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
      initialProvider="anthropic"
      sessionIndex={index}
    />
  );
}

describe("App", () => {
  it("shows the welcome message on startup", async () => {
    const { lastFrame } = makeApp();
    await wait(30);
    expect(lastFrame()).toContain("0.1.0");
  });

  it("fetches the provider model list on session creation", async () => {
    makeApp();
    await wait(50);
    expect(vi.mocked(fetchModels)).toHaveBeenCalledWith({});
  });

  it("completes /model from the fetched list in the UI", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait(50);
    stdin.write("/model model-");
    await wait(50);
    expect(lastFrame()).toContain("model-a");
    expect(lastFrame()).toContain("model-b");
  });

  it("/set project <path> calls onSwitchProject with the resolved path", async () => {
    const onSwitchProject = vi.fn();
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin } = render(
      <App
        cwd={process.cwd()}
        providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
        initialProvider="anthropic"
        sessionIndex={index}
        onSwitchProject={onSwitchProject}
      />
    );
    await wait();
    stdin.write(`/set project ${process.cwd()}`);
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSwitchProject).toHaveBeenCalledWith(process.cwd());
  });

  it("/set project <bad path> shows a notice and does not call onSwitchProject", async () => {
    const onSwitchProject = vi.fn();
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App
        cwd={process.cwd()}
        providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
        initialProvider="anthropic"
        sessionIndex={index}
        onSwitchProject={onSwitchProject}
      />
    );
    await wait();
    stdin.write("/set project /definitely/does/not/exist");
    await wait();
    stdin.write("\r");
    await wait();
    expect(lastFrame()).toContain("Not a directory");
    expect(onSwitchProject).not.toHaveBeenCalled();
  });

  it("onSwitchProject returning an error string shows a notice instead of switching silently", async () => {
    const onSwitchProject = vi.fn().mockReturnValue("Failed to switch project: EACCES");
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App
        cwd={process.cwd()}
        providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
        initialProvider="anthropic"
        sessionIndex={index}
        onSwitchProject={onSwitchProject}
      />
    );
    await wait();
    stdin.write(`/set project ${process.cwd()}`);
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSwitchProject).toHaveBeenCalledWith(process.cwd());
    expect(lastFrame()).toContain("Failed to switch project: EACCES");
  });

  it("seeds session model and permission mode from initial props", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { lastFrame } = render(
      <App
        cwd="/p"
        providers={{ anthropic: { model: "provider-default" } }}
        initialProvider="anthropic"
        initialModel="my-model"
        initialMode="acceptEdits"
        sessionIndex={index}
      />
    );
    await wait(50);
    expect(vi.mocked(EngineLoop).mock.calls[0][0]).toMatchObject({ model: "my-model", permissionMode: "acceptEdits" });
    expect(lastFrame()).toContain("acceptEdits");
    expect(lastFrame()).toContain("my-model");
  });

  it("switches live to bypassPermissions without restarting the session", async () => {
    const setPermissionModeSpy = vi.spyOn(AgentSession.prototype, "setPermissionMode");
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait(50);
    stdin.write("[Z"); // shift+tab: default -> acceptEdits (live switch)
    await wait(50);
    expect(setPermissionModeSpy).toHaveBeenCalledWith("acceptEdits");
    stdin.write("[Z"); // shift+tab: acceptEdits -> bypassPermissions (live switch)
    await wait(100);
    expect(setPermissionModeSpy).toHaveBeenCalledWith("bypassPermissions");
    expect(vi.mocked(EngineLoop).mock.calls.length).toBe(1);
    expect(lastFrame()).toContain("bypassPermissions");
    setPermissionModeSpy.mockRestore();
  });

  it("round-trips a user message to assistant output", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("> hi");
    expect(lastFrame()).toContain("hello from model");
  });

  it("shows token usage and context percent after a result message", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([
        textTurn("hello from model", {
          input_tokens: 9000,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 0,
          output_tokens: 345
        })
      ])
    );
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("12.3k tok");
    expect(lastFrame()).toContain("(6%)");
  });

  it("auto-compacts when a result pushes context usage to 80% or above", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([
        textTurn("hello from model", {
          input_tokens: 170_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 100
        }),
        [
          { type: "content_block_start", content_block: { type: "text" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "short recap" } },
          { type: "content_block_stop" },
          { type: "message_stop" }
        ]
      ])
    );
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(300);
    expect(lastFrame()).toContain("compacted automatically");
    expect(lastFrame()).not.toContain("(85%)");
  });

  it("shows an error notice instead of crashing when a slash command rejects", async () => {
    const setModelSpy = vi.spyOn(AgentSession.prototype, "setModel").mockRejectedValue(new Error("not a recognized model id"));
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("/model bogus");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("not a recognized model id");
    setModelSpy.mockRestore();
  });

  it("handles unknown slash command with a notice", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/nope");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("Unknown command: /nope");
  });

  it("switches provider via /provider and shows it in status bar", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/provider local");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("local");
  });

  it("streams partial text then replaces it with the final message", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    let releaseFinal: () => void = () => {};
    const gate = new Promise<void>(r => { releaseFinal = r; });
    vi.mocked(makeClient).mockReturnValue(
      fakeClient(async function* () {
        yield { type: "content_block_start", content_block: { type: "text" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "par" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "tial" } };
        await gate;
        yield { type: "content_block_delta", delta: { type: "text_delta", text: " and final" } };
        yield { type: "content_block_stop" };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
      })
    );
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("partial");          // partial text visible while gated
    releaseFinal();
    await wait(100);
    expect(lastFrame()).toContain("partial and final"); // final replaces it
    const finalFrame = lastFrame()!;
    expect(finalFrame.match(/partial/g)!.length).toBe(1); // no duplicate partial+final
  });

  it("caps the streaming preview to a tail so the dynamic region fits the terminal", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const manyLines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    vi.mocked(makeClient).mockReturnValue(
      fakeClient(async function* () {
        yield { type: "content_block_start", content_block: { type: "text" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: manyLines } };
        await new Promise(() => {}); // stay streaming forever
      })
    );
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(100);
    const frame = lastFrame()!;
    expect(frame).toContain("line-99");     // tail is visible
    expect(frame).not.toContain("line-0\n"); // head is trimmed
  });

  it("shows the working indicator while streaming", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    vi.mocked(makeClient).mockReturnValue(
      fakeClient(async function* () {
        await new Promise(() => {}); // never resolves
      })
    );
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("Thinking");
  });

  it("shows a permission dialog for a write with no stored rule, and 'Always' saves a rule for next time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
    const filePath = join(cwd, "src", "file.ts");
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([
        toolUseTurn("t1", "Write", { file_path: filePath, content: "x" }),
        textTurn("done"),
        toolUseTurn("t2", "Write", { file_path: filePath, content: "y" }),
        textTurn("done again")
      ])
    );
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("first");
    await wait();
    stdin.write("\r");
    await wait(150);
    expect(lastFrame()).toContain("Permission required");
    stdin.write("a"); // Always for this directory
    await wait(150);
    const { PermissionStore } = await import("../src/agent/permissionStore.js");
    expect(new PermissionStore(cwd).check("Write", filePath)).toBe("allow");
  });

  it("a stored deny rule prevents the write without showing a dialog", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
    const { PermissionStore } = await import("../src/agent/permissionStore.js");
    const filePath = join(cwd, "secret", "x.txt");
    new PermissionStore(cwd).remember("Write", filePath, "deny");
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([toolUseTurn("t1", "Write", { file_path: filePath, content: "x" }), textTurn("done")])
    );
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(150);
    // Resolved silently by the engine's own permission store; no dialog interrupts the turn.
    expect(lastFrame()).not.toContain("Permission required");
    expect(lastFrame()).toContain("done");
  });
});

describe("bottom-anchored footer", () => {
  it("pads a short transcript so the status bar sits near the terminal bottom", async () => {
    const { lastFrame } = makeApp();
    await wait();
    const lines = lastFrame()!.split("\n");
    // ink-testing-library has no real TTY, so App falls back to 24 rows.
    // Welcome banner + filler + input box + status bar must fill the
    // screen to exactly the 24-row fallback minus the 1-row reserve.
    // Without the filler the frame is only 21 lines (the banner alone),
    // so >= 23 discriminates against a missing filler.
    expect(lines.length).toBeGreaterThanOrEqual(23);
    // Status bar (provider segment) must be the last line.
    expect(lines[lines.length - 1]).toContain("anthropic");
  });

  it("keeps the status bar one row above the terminal's bottom edge", async () => {
    // Regression test for the welcome-banner scroll bug: Ink terminates
    // every frame with "\n", so a frame whose content reaches the terminal's
    // last row scrolls the screen by one and permanently clips the top of
    // the <Static> transcript. The filler must therefore stop at rows-1
    // (23 lines on the 24-row fallback), leaving the trailing newline to
    // land on row 24 without scrolling.
    const { lastFrame } = makeApp();
    await wait(60); // let effects (measureElement) settle post-render
    const lines = lastFrame()!.split("\n");
    expect(lines.length).toBe(23); // rows - 1: bottom row left for Ink's trailing "\n"
    expect(lines[lines.length - 1]).toContain("anthropic"); // StatusBar at row 24
    // The row above the StatusBar is the InputBox's bottom border (a
    // round-corner box-drawing char), confirming the StatusBar itself —
    // not the input box's last content row — sits on the bottom edge.
    const inputBoxBottomBorder = lines[lines.length - 2];
    const borderChars = ["╰", "└", "┌", "╭", "─"];
    expect(borderChars.some(c => inputBoxBottomBorder.includes(c))).toBe(true);
  });
});
