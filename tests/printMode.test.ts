import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(code).toBe(0);
    expect(errText()).toContain("[denied] Write");
  });

  it("returns 1 and prints the error when the API fails", async () => {
    vi.mocked(makeClient).mockReturnValue({
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
});
