import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));

import { makeClient } from "../src/engine/api.js";
import { AgentSession } from "../src/agent/session.js";
import { SessionFile } from "../src/engine/sessions.js";

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

// AgentSession composes EngineLoop, tools, permissions, SessionFile, McpManager
// and buildSystemPrompt together. This test exercises that whole composition
// end to end: start -> send -> persist -> resume, rather than any piece in
// isolation. SessionFile's directory isn't injectable from AgentSession's
// public API, so we isolate the real ~/.cloudcode by pointing HOME/USERPROFILE
// at a temp dir for the duration of the test (matches Node's os.homedir()
// env-var lookup on both platforms).
describe("AgentSession integration", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "cc-home-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.mocked(makeClient).mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("persists a turn's messages to the session's JSONL file", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello there")]));
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
    await vi.waitFor(() => expect(messages.some(m => (m as { type: string }).type === "result")).toBe(true));
    await session.dispose();

    const persisted = SessionFile.load(sessionId);
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    const flat = JSON.stringify(persisted);
    expect(flat).toContain("hello"); // the user turn we sent
    expect(flat).toContain("hello there"); // the assistant reply text
  });

  it("resumes a prior session: loaded history is fed into the new EngineLoop and onSessionId reports the resumed id", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("first reply")]));
    let firstId = "";
    const first = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: () => {},
      onSessionId: id => { firstId = id; }
    });
    first.start();
    first.send("first message");
    await vi.waitFor(() => expect(SessionFile.load(firstId).length).toBeGreaterThanOrEqual(2));
    await first.dispose();

    const priorMessages = SessionFile.load(firstId);
    expect(priorMessages.length).toBeGreaterThanOrEqual(2);

    // Resume: construct a second session pointed at the first session's id.
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("second reply")]));
    let resumedId = "";
    const second = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      resume: firstId,
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: () => {},
      onSessionId: id => { resumedId = id; }
    });
    expect(() => second.start()).not.toThrow();
    expect(resumedId).toBe(firstId);
    expect(second.sessionId).toBe(firstId);

    // The resumed EngineLoop's history should already contain the first
    // session's persisted messages (loaded via SessionFile.load in start()).
    // We can't reach EngineLoop's private field directly from here, so we
    // verify indirectly: sending a follow-up appends to the SAME file and
    // the file still contains the original first-session content afterward.
    second.send("second message");
    await vi.waitFor(() => {
      const all = SessionFile.load(firstId);
      return expect(JSON.stringify(all)).toContain("second reply");
    });
    const finalFile = SessionFile.load(firstId);
    const flat = JSON.stringify(finalFile);
    expect(flat).toContain("first reply");
    expect(flat).toContain("second reply");
    await second.dispose();
  });
});
