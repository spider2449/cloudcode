import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));

import { makeClient } from "../src/engine/api.js";
import { runPrint } from "../src/printMode.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

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

function toolTurn(name: string, input: Record<string, unknown>): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }
  ];
}

function collectIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    outText: () => out.join(""),
    errText: () => err.join("")
  };
}

let home: string;
let saved: { HOME?: string; USERPROFILE?: string };
let sessionIndex: SessionIndex;

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
  home = mkdtempSync(join(tmpdir(), "print-home-"));
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  sessionIndex = new SessionIndex(join(home, "sessions.json"));
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

const baseOpts = () => ({
  prompt: "hi",
  providerName: "anthropic",
  provider: {},
  permissionMode: "default" as const,
  cwd: home,
  sessionIndex
});

describe("runPrint", () => {
  it("streams assistant text to stdout and exits 0", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io, outText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(0);
    expect(outText()).toBe("hello\n");
  });

  it("auto-denies permission requests and reports the tool on stderr", async () => {
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([toolTurn("Write", { file_path: join(home, "x.txt"), content: "x" }), textTurn("done")]) as never
    );
    const { io, errText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(3);
    expect(errText()).toContain("[denied] Write");
  });

  it("returns 1 and prints the error when the API fails", async () => {
    vi.mocked(makeClient).mockReturnValue({
      // oxlint-disable-next-line require-yield -- mock only throws, never yields
      create: vi.fn(async function* () { throw new Error("boom"); })
    } as never);
    const { io, errText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(1);
    expect(errText()).toContain("boom");
  });

  it("records the session in the session index so -c can resume it", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(0);
    const entries = sessionIndex.listForCwd(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      cwd: home,
      provider: "anthropic",
      firstMessage: "hi"
    });
  });

  it("ignores untrusted project executable configuration and warns on stderr", async () => {
    writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { untrusted: { command: "node" } } }));
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io, errText } = collectIo();
    expect(await runPrint(baseOpts(), io)).toBe(0);
    expect(errText()).toContain("Ignored untrusted project MCP/LSP configuration");
  });

  it("emits one final JSON document with events and result metadata", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io, outText, errText } = collectIo();
    expect(await runPrint({ ...baseOpts(), outputFormat: "json" }, io)).toBe(0);
    expect(outText().trim().split("\n")).toHaveLength(1);
    const document = JSON.parse(outText());
    expect(document.schemaVersion).toBe(1);
    expect(document.result).toMatchObject({
      provider: "anthropic", model: "claude-sonnet-5", finishReason: "completed", exitCode: 0
    });
    expect(document.result.sessionId).toBeTruthy();
    expect(document.events.map((event: { event: { kind: string } }) => event.event.kind)).toEqual([
      "run.started", "network.decision", "assistant.text_delta", "assistant.message", "run.finished"
    ]);
    expect(errText()).toBe("");
  });

  it("emits parseable stream-json with monotonic sequence numbers", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io, outText, errText } = collectIo();
    expect(await runPrint({ ...baseOpts(), outputFormat: "stream-json" }, io)).toBe(0);
    const events = outText().trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events.at(-1).event).toMatchObject({ kind: "run.finished", exitCode: 0 });
    expect(errText()).toBe("");
  });

  it("returns 4 and stops before tool execution at maxTurns", async () => {
    const client = fakeClient([toolTurn("Write", { file_path: join(home, "x"), content: "x" }), textTurn("never")]);
    vi.mocked(makeClient).mockReturnValue(client as never);
    const { io, outText } = collectIo();
    expect(await runPrint({
      ...baseOpts(), outputFormat: "stream-json", permissionMode: "acceptEdits", runLimits: { maxTurns: 1 }
    }, io)).toBe(4);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(outText()).toContain('"kind":"limit.reached"');
    expect(outText()).toContain('"finishReason":"limit"');
  });

  it("returns 2 before client creation when cost pricing is unknown", async () => {
    const { io, outText } = collectIo();
    expect(await runPrint({
      ...baseOpts(), model: "mystery-model", outputFormat: "json", runLimits: { maxCostUsd: 1 }
    }, io)).toBe(2);
    expect(makeClient).not.toHaveBeenCalled();
    expect(JSON.parse(outText()).result).toMatchObject({ exitCode: 2, finishReason: "error" });
  });

  it("returns 4 when timeout aborts an in-flight provider request", async () => {
    vi.mocked(makeClient).mockReturnValue({
      // oxlint-disable-next-line require-yield -- mock waits for abort then throws
      create: vi.fn(async function* (_request: unknown, signal: AbortSignal) {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      })
    } as never);
    const { io, outText } = collectIo();
    expect(await runPrint({ ...baseOpts(), outputFormat: "stream-json", runLimits: { timeoutMs: 20 } }, io)).toBe(4);
    expect(outText()).toContain('"limit":"timeoutMs"');
    expect(outText()).toContain('"exitCode":4');
  });

  it("emits a final interrupted event and returns 130 on Ctrl+C", async () => {
    const signals = new EventEmitter();
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(makeClient).mockReturnValue({
      // oxlint-disable-next-line require-yield -- mock waits for abort then throws
      create: vi.fn(async function* (_request: unknown, signal: AbortSignal) {
        started();
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })
    } as never);
    const { io, outText } = collectIo();
    const pending = runPrint({ ...baseOpts(), outputFormat: "stream-json", interruptSource: signals }, io);
    await providerStarted;
    signals.emit("SIGINT");
    expect(await pending).toBe(130);
    expect(outText()).toContain('"finishReason":"interrupted"');
    expect(outText()).toContain('"exitCode":130');
  });

  it("redacts configured API keys from structured provider errors", async () => {
    vi.mocked(makeClient).mockReturnValue({
      // oxlint-disable-next-line require-yield -- mock only throws
      create: vi.fn(async function* () { throw new Error("upstream echoed sk-private"); })
    } as never);
    const { io, outText } = collectIo();
    expect(await runPrint({
      ...baseOpts(), provider: { apiKey: "sk-private" }, outputFormat: "json"
    }, io)).toBe(1);
    expect(outText()).not.toContain("sk-private");
    expect(outText()).toContain("[REDACTED_SECRET]");
  });

  it("returns 7 when configured HTTP MCP egress is denied", async () => {
    writeFileSync(join(home, ".mcp.json"), JSON.stringify({
      mcpServers: { remote: { type: "sse", url: "https://mcp.example/sse" } }
    }));
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("provider still replies")]) as never);
    const { io, outText } = collectIo();
    expect(await runPrint({
      ...baseOpts(), outputFormat: "stream-json", trustProjectConfig: true, networkMode: "providerOnly"
    }, io)).toBe(7);
    expect(outText()).toContain('"capability":"mcpHttp"');
    expect(outText()).toContain('"allowed":false');
    expect(outText()).toContain('"exitCode":7');
  });

  it("includes the completed change checkpoint in final JSON metadata", async () => {
    const path = join(home, "made.txt");
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([toolTurn("Write", { file_path: path, content: "made" }), textTurn("done")]) as never
    );
    const { io, outText } = collectIo();
    expect(await runPrint({
      ...baseOpts(), outputFormat: "json", permissionMode: "acceptEdits"
    }, io)).toBe(0);
    const document = JSON.parse(outText());
    expect(document.result.checkpoint).toMatchObject({ changedFiles: 1 });
    expect(document.events.at(-2).event).toMatchObject({ kind: "checkpoint.completed", changedFiles: 1 });
    expect(document.events.at(-1).event.kind).toBe("run.finished");
  });
});
