import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));

import { makeClient } from "../src/engine/api.js";
import { AgentSession, shouldExtract } from "../src/agent/session.js";
import { McpManager } from "../src/engine/mcpClient.js";
import { ChangeJournal } from "../src/agent/changeJournal.js";

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
  it("denies a remote provider before creating its client in offlineStrict", () => {
    const session = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "default", networkMode: "offlineStrict", cwd: "/p",
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {}
    });
    expect(() => session.start()).toThrow(/nonLoopbackProvider/);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("removes ordinary Bash from strict loopback sessions", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "default", networkMode: "offlineStrict", cwd: "/p",
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    expect(session.tools).not.toContain("Bash");
    expect(session.tools).toContain("Read");
    await session.dispose();
  });

  it("exposes only an explicit read-only tool allowlist", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "default", cwd: "/p", toolAllowlist: ["Read", "Glob", "Grep", "Diagnostics"],
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    expect(session.tools).toEqual(["Read", "Glob", "Grep", "Diagnostics"]);
    expect(session.tools).not.toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    await session.dispose();
  });

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
      // oxlint-disable-next-line require-yield -- mock only aborts/throws, never yields
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

  it("send() surfaces a session-file write failure as an error message instead of an unhandled rejection", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const messages: unknown[] = [];
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: m => messages.push(m),
      onPermissionRequest: () => {},
      onSessionId: () => {}
    });
    session.start();
    (session as unknown as { sessionFile: { append(entry: unknown): void } }).sessionFile = {
      append() { throw new Error("disk full"); }
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      session.send("hello");
      await vi.waitFor(() => {
        const errors = messages.filter(m => (m as { subtype?: string }).subtype === "error_during_execution");
        expect(errors.length).toBe(1);
        expect((errors[0] as { result: string }).result).toContain("disk full");
      });
      await new Promise(r => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      await session.dispose();
    }
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

  it("waits for MCP discovery before assembling the first request", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new McpManager(async () => {
      await gate;
      return {
        listTools: async () => ({ tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {}
      };
    });
    const requests: Array<{ tools?: Array<{ name: string }> }> = [];
    const client = {
      async *create(req: { tools?: Array<{ name: string }> }) {
        requests.push(req);
        yield* textTurn("done");
      }
    };
    vi.mocked(makeClient).mockReturnValue(client as never);
    const messages: unknown[] = [];
    const session = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "default", cwd: "/p",
      mcpServers: { demo: { command: "fake" } }, mcpManager: manager,
      onMessage: message => messages.push(message), onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    session.send("use mcp");
    await new Promise(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(messages.some(message => (message as { type?: string }).type === "result")).toBe(true));
    expect(requests[0].tools?.map(tool => tool.name)).toContain("mcp__demo__lookup");
    await session.dispose();
  });

  it("counts MCP readiness against the complete run timeout", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("never")]));
    const manager = new McpManager(async () => new Promise(() => {}));
    const messages: unknown[] = [];
    const session = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "default", cwd: "/p",
      mcpServers: { slow: { command: "slow" } }, mcpManager: manager, runLimits: { timeoutMs: 10 },
      onMessage: message => messages.push(message), onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    await expect(session.ready()).rejects.toMatchObject({ code: "RUN_LIMIT_REACHED", limit: "timeoutMs" });
    expect(messages).toContainEqual({ type: "limit", limit: "timeoutMs", value: 10 });
    await session.dispose();
  });

  it("groups native edits from one turn into a durable checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-session-changes-"));
    const project = join(root, "project");
    const path = join(project, "made.txt");
    vi.mocked(makeClient).mockReturnValue(fakeClient([
      toolUseTurn("t1", "Write", { file_path: path, content: "made" }),
      textTurn("done")
    ]));
    const messages: unknown[] = [];
    const session = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "acceptEdits", cwd: project,
      changeJournalFactory: (cwd, id) => new ChangeJournal(cwd, id, { rootDir: join(root, "journal") }),
      onMessage: message => messages.push(message), onPermissionRequest: () => {}, onSessionId: () => {}
    });
    try {
      session.start();
      session.send("make it");
      await vi.waitFor(() => expect(messages.some(message => (message as { type?: string }).type === "result")).toBe(true));
      await vi.waitFor(() => expect(session.isTurnActive()).toBe(false));
      expect(readFileSync(path, "utf8")).toBe("made");
      expect(session.changeSummaries()).toHaveLength(1);
      expect(session.previewUndo().operations).toEqual([{ path, action: "remove" }]);
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
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

describe("AgentSession hooks", () => {
  function hooksSession(cwd: string, configBase?: string, messages?: unknown[]) {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]));
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "default", networkMode: "offlineStrict",
      cwd, ...(configBase ? { configBase } : {}),
      onMessage: m => messages?.push(m),
      onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    return session;
  }

  it("surfaces exactly one untrusted-project notice at startup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-sess-hp-"));
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(cwd, ".cloudcode", "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ command: "echo stop-hook-ran" }] }
    }));
    const messages: unknown[] = [];
    const session = hooksSession(cwd, undefined, messages);
    const noticeText = (m: unknown) =>
      String((m as { content?: string }).content ?? "") + String((m as { result?: string }).result ?? "");
    const notices = messages.filter(m =>
      noticeText(m).includes("hooks.json") && noticeText(m).includes("not trusted"));
    expect(notices).toHaveLength(1);
    await session.dispose();
  });

  it("runs a trusted user-layer SessionEnd hook exactly once on dispose", async () => {
    const { existsSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "cc-sess-he-"));
    const configBase = mkdtempSync(join(tmpdir(), "cc-sess-he-base-"));
    const marker = join(mkdtempSync(join(tmpdir(), "cc-sess-he-mark-")), "marker.txt");
    const command = process.platform === "win32"
      ? `Set-Content -LiteralPath '${marker}' -Value done`
      : `echo done > '${marker}'`;
    writeFileSync(join(configBase, "hooks.json"), JSON.stringify({
      hooks: { SessionEnd: [{ command, timeoutMs: 15000 }] }
    }));
    const session = hooksSession(cwd, configBase);
    expect(existsSync(marker)).toBe(false); // nothing runs during construction
    await session.dispose();
    expect(existsSync(marker)).toBe(true);
  });
});

import { SessionFile } from "../src/engine/sessions.js";

describe("AgentSession todos", () => {
  function todoSession(cwd: string, messages?: unknown[], clientTurns?: Event[][]) {
    vi.mocked(makeClient).mockReturnValue(fakeClient(clientTurns ?? [[textTurn("ok")]]));
    return new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "bypassPermissions", networkMode: "offlineStrict", cwd,
      onMessage: m => messages?.push(m),
      onPermissionRequest: () => {}, onSessionId: () => {}
    });
  }

  const toolUseTodosTurn = (): Event[] => [
    { type: "content_block_start", content_block: { type: "tool_use", id: "tu_9", name: "TodoWrite" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ todos: [{ content: "step one", status: "completed" }] }) } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }
  ];

  it("broadcasts a todos message when the model calls TodoWrite", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-sess-todo-"));
    const messages: unknown[] = [];
    const session = todoSession(cwd, messages, [toolUseTodosTurn(), [textTurn("done")]]);
    session.start();
    session.send("do the steps");
    await vi.waitFor(() => {
      expect(messages.some(m => (m as { type?: string }).type === "todos")).toBe(true);
    });
    const todosMsgs = messages.filter(m => (m as { type?: string }).type === "todos");
    expect((todosMsgs[0] as { todos: Array<{ content: string }> }).todos[0].content).toBe("step one");
    await session.dispose();
  });

  it("persists the additive todos record through SessionFile round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess-todofile-"));
    const sf = new SessionFile("todo-session", dir);
    sf.append({ role: "user", content: "go" });
    sf.append({ type: "todos", todos: [{ content: "step one", status: "completed" }] });
    sf.append({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    const loaded = SessionFile.load("todo-session", dir);
    const todosRecords = loaded.filter(e => (e as { type?: string }).type === "todos");
    expect(todosRecords).toHaveLength(1);
    expect((todosRecords[0] as { todos: Array<{ status: string }> }).todos[0].status).toBe("completed");
  });

  it("excludes todos records from resumed API history and replays the latest", async () => {
    // Build a session file by hand: API messages with a todos record sandwiched in.
    const dir = mkdtempSync(join(tmpdir(), "cc-sess-todoresume-"));
    const sf = new SessionFile("resume-todos", dir);
    sf.append({ role: "user", content: "go" });
    sf.append({ type: "todos", todos: [{ content: "old step", status: "completed" }] });
    sf.append({ role: "assistant", content: [{ type: "text", text: "partial" }] });

    const requests: unknown[] = [];
    const messages: unknown[] = [];
    vi.mocked(makeClient).mockReturnValue({
      create: async function* (req: unknown) {
        requests.push(req);
        for (const e of [textTurn("resumed ok")]) yield e as never;
      }
    });
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "bypassPermissions", networkMode: "offlineStrict",
      cwd: mkdtempSync(join(tmpdir(), "cc-sess-todoresume-cwd-")), resume: "resume-todos", sessionDir: dir,
      onMessage: m => messages.push(m), onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    // Replay: the UI receives the stored snapshot at startup.
    const replayed = messages.filter(m => (m as { type?: string }).type === "todos");
    expect(replayed).toHaveLength(1);
    expect((replayed[0] as { todos: Array<{ content: string }> }).todos[0].content).toBe("old step");

    session.send("continue");
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0);
    });
    // The todos record never enters API history.
    const req = requests[requests.length - 1] as { messages: unknown[] };
    for (const m of req.messages) {
      expect((m as { type?: string }).type).not.toBe("todos");
    }
    await session.dispose();
  });
});

describe("AgentSession background shells", () => {
  it("exposes BashOutput/KillShell and disposes cleanly", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([[textTurn("ok")]]));
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "default", networkMode: "offlineStrict",
      cwd: mkdtempSync(join(tmpdir(), "cc-sess-bg-")),
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    expect(session.tools).toContain("BashOutput");
    expect(session.tools).toContain("KillShell");
    await session.dispose();
  });
});
