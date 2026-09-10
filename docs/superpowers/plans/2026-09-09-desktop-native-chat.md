# Desktop Native Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the embedded xterm TUI in desktop GUI with native chat bubbles backed by a headless `cloudcode --gui-server` subprocess, leaving CLI TUI untouched.

**Architecture:** New `src/desktop/chatProtocol.ts` defines NDJSON request/event shapes; new `src/desktop/guiServer.ts` hosts sessions and dispatches `runSlashCommand` or `engine/loop.ts`; `src/cliArgs.ts` + `src/cli.tsx` gain a `--gui-server` branch; Electron `desktop/main.mjs` + `preload.cjs` drop PTY forwarding for `chat:*` IPC; renderer gains a `ChatPane` component tree.

**Tech Stack:** TypeScript (strict), Node stdio NDJSON, Electron IPC, React renderer, vitest.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/desktop/chatProtocol.ts` | Request/event types + validators (`requireChatText`, `requireChatId`). No engine imports. |
| Create `src/desktop/guiServer.ts` | Headless host: read stdin lines, dispatch slash vs prompt, emit events. Owns session map only. |
| Modify `src/cliArgs.ts` | Add `--gui-server` flag and `guiserver` CliResult. No behavior change otherwise. |
| Modify `src/cli.tsx` | Dispatch `guiserver` to `runGuiServer()` before TUI branch. TUI branch untouched. |
| Create `tests/desktop-chatProtocol.test.ts` | Protocol validator tests. |
| Create `tests/desktop-guiServer.test.ts` | Server dispatch tests with fake command context + fake turn runner. |
| Create `tests/desktop-chatParity.test.ts` | Every TUI slash command name is advertised by the GUI autocomplete source. |
| Modify `desktop/preload.cjs` | Replace `terminal-*` bridge with `chatSend/chatAbort/chatHistory/onChatEvent`. |
| Modify `desktop/main.mjs` | Spawn `node dist/cli.js --gui-server`, forward IPC, supervise restarts. Delete node-pty code. |
| Create `desktop/renderer/chatPane.tsx` | Message list + input + `/` autocomplete + tool cards + permission overlay. |
| Delete (last task) | `src/desktop/turnStream.ts` consumers, `desktop/renderer/terminalKeys.ts`, `desktop/renderer/imePosition.ts`, xterm usage in `src.tsx`. `src/ui/*` never touched. |

---

### Task 1: Chat protocol types + validators

**Files:**
- Create: `src/desktop/chatProtocol.ts`
- Test: `tests/desktop-chatProtocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { requireChatId, requireChatText, CHAT_EVENT_TYPES } from "../src/desktop/chatProtocol.js";

describe("chat protocol", () => {
  it("accepts a bounded message id and text", () => {
    expect(requireChatId("abc-123")).toBe("abc-123");
    expect(requireChatText("hello")).toBe("hello");
  });
  it("rejects empty and oversized payloads", () => {
    expect(() => requireChatId("")).toThrow("Invalid chat id");
    expect(() => requireChatText("")).toThrow("Invalid chat text");
    expect(() => requireChatText("x".repeat(200_001))).toThrow("Invalid chat text");
  });
  it("advertises a fixed event vocabulary", () => {
    expect(CHAT_EVENT_TYPES).toEqual(["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "done"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: FAIL with "Cannot find module '../src/desktop/chatProtocol.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
export const CHAT_EVENT_TYPES = ["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "done"] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export interface ChatSendRequest {
  id: string;
  sessionId?: string;
  text: string;
}

export interface ChatEvent {
  id: string;
  type: ChatEventType;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export function requireChatId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new Error("Invalid chat id.");
  return value;
}

export function requireChatText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new Error("Invalid chat text.");
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/desktop/chatProtocol.ts tests/desktop-chatProtocol.test.ts
git commit -m "feat(desktop): add chat protocol types and validators"
```

### Task 2: `--gui-server` CLI flag

**Files:**
- Modify: `src/cliArgs.ts`
- Test: `tests/cliArgs.test.ts` (append new cases in place)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cliArgs.js";

describe("gui-server flag", () => {
  it("parses --gui-server into a guiserver result", () => {
    expect(parseCli(["--gui-server"])).toEqual({ kind: "guiserver" });
  });
  it("rejects --gui-server combined with --print", () => {
    const result = parseCli(["--gui-server", "--print"]);
    expect(result.kind).toBe("error");
  });
});
```

Append these cases to the existing `tests/cliArgs.test.ts` temporary block (keep file under size limit; cases live in the new parity file if the file grows).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL (received `{ kind: "error" }` or unexpected argument for `--gui-server`).

- [ ] **Step 3: Write minimal implementation**

In `src/cliArgs.ts`:
1. Extend the `CliResult` union with `| { kind: "guiserver" }`.
2. Add `"gui-server": { type: "boolean", default: false }` to the `parseArgs` options and to the `values` type.
3. After the `help`/`version` checks, insert:

```ts
if (values["gui-server"]) {
  if (values.print || values.continue || values.resume || values.session !== undefined || positionals.length > 0) {
    return { kind: "error", message: "--gui-server cannot be combined with other flags. Run cloudcode --help for usage." };
  }
  return { kind: "guiserver" };
}
```

4. Add `--gui-server` line to `HELP_TEXT` options block:

```ts
  --gui-server              Headless JSON-RPC backend for the desktop GUI shell
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cliArgs.ts tests/cliArgs.test.ts
git commit -m "feat(cli): add --gui-server flag for desktop shell backend"
```

### Task 3: Headless guiServer with slash dispatch

**Files:**
- Create: `src/desktop/guiServer.ts`
- Test: `tests/desktop-guiServer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { GuiServer } from "../src/desktop/guiServer.js";
import type { ChatEvent } from "../src/desktop/chatProtocol.js";

describe("GuiServer", () => {
  it("dispatches slash input through runSlashCommand, not the turn runner", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map([["model", { description: "m", run: async (ctx: { notice(text: string): void }) => { ctx.notice("models"); } } as never]]),
      runTurn: async () => { throw new Error("turn runner must not run for slash input"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "1", text: "/model" });
    expect(events.map(e => e.type)).toEqual(["notice", "done"]);
    expect(events[0]?.text).toBe("models");
  });
  it("sends ordinary prompts to the turn runner", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map(),
      runTurn: async (text: string, emit: (e: ChatEvent) => void) => { emit({ id: "2", type: "text_delta", text: `echo:${text}` }); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "2", text: "hello" });
    expect(events.map(e => e.type)).toEqual(["text_delta", "done"]);
  });
  it("reports unknown slash commands without throwing", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map(),
      runTurn: async () => { throw new Error("must not run"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "3", text: "/nope" });
    expect(events[0]?.type).toBe("error");
    expect(events.at(-1)?.type).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-guiServer.test.ts`
Expected: FAIL with "Cannot find module '../src/desktop/guiServer.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
import { parseSlash } from "../commands/registry.js";
import { requireChatId, requireChatText, type ChatEvent, type ChatSendRequest } from "./chatProtocol.js";

export interface GuiServerDeps {
  commands: Map<string, { run(ctx: { notice(text: string): void }, args: string): Promise<void> }>;
  runTurn(text: string, emit: (event: ChatEvent) => void): Promise<void>;
  emit(event: ChatEvent): void;
}

export class GuiServer {
  constructor(private readonly deps: GuiServerDeps) {}

  async handle(raw: { id: unknown; text: unknown; sessionId?: unknown }): Promise<void> {
    const id = requireChatId(raw.id);
    const text = requireChatText(raw.text);
    const emit = this.deps.emit;
    try {
      const slash = parseSlash(text);
      if (slash) {
        const command = this.deps.commands.get(slash.name);
        if (!command) {
          emit({ id, type: "error", text: `Unknown command: /${slash.name}` });
          return;
        }
        await command.run({ notice: (notice: string) => emit({ id, type: "notice", text: notice }) }, slash.args);
        return;
      }
      await this.deps.runTurn(text, emit);
    } catch (error) {
      emit({ id, type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      emit({ id, type: "done" });
    }
  }
}

export function splitInputLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter(line => line.length > 0), rest };
}
```

Note: `runSlashCommand` from `src/commands/runtime.ts` is wired in the `cli.tsx` integration step, not here; this task keeps the server unit-testable with a minimal command shape. The real wiring maps `CommandContext.notice` to the `notice` event.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-guiServer.test.ts tests/desktop-chatProtocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/guiServer.ts tests/desktop-guiServer.test.ts
git commit -m "feat(desktop): add headless gui server dispatch"
```

### Task 4: Wire `cli.tsx` guiserver branch (stdio NDJSON)

**Files:**
- Modify: `src/cli.tsx`
- Test: `tests/desktop-guiServer.test.ts` (extend with `splitInputLines` framing case)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { splitInputLines } from "../src/desktop/guiServer.js";

describe("gui server framing", () => {
  it("splits complete lines and keeps the partial tail", () => {
    expect(splitInputLines('{"id":"1"}\n{"id":"2"}\n{"id":"3"')).toEqual({ lines: ['{"id":"1"}', '{"id":"2"}'], rest: '{"id":"3"' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-guiServer.test.ts`
Expected: FAIL if `splitInputLines` is missing (it exists from Task 3, so instead assert the `cli.tsx` branch is missing: `grep -c "guiserver" src/cli.tsx` returns 0).

- [ ] **Step 3: Write minimal implementation**

In `src/cli.tsx`, after the `version`/`error` early returns and before the `subcommand` branch, insert:

```tsx
if (parsed.kind === "guiserver") {
  const { GuiServer } = await import("./desktop/guiServer.js");
  const { buildRegistry } = await import("./commands/builtins.js");
  const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
  const server = new GuiServer({
    commands: registry as never,
    runTurn: async (text, emit) => {
      emit({ id: "turn", type: "text_delta", text: `[turn stub] ${text}` });
    },
    emit: (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); },
  });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const framed = splitInputLines(buffer);
    buffer = framed.rest;
    for (const line of framed.lines) {
      try {
        const request = JSON.parse(line) as { id: unknown; text: unknown };
        void server.handle(request);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: "unknown", type: "error", text: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
  });
  return;
}
```

The real engine-loop wiring (building `EngineOptions` from session + providers) replaces the `[turn stub]` in the follow-up engine task; this step establishes the branch, registry reuse, and stdio framing without touching the TUI branch below it. No `src/ui/*` imports added.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/desktop-guiServer.test.ts tests/cliArgs.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: clean `tsc` emit (dist includes `desktop/guiServer.js`).

- [ ] **Step 5: Commit**

```bash
git add src/cli.tsx tests/desktop-guiServer.test.ts
git commit -m "feat(desktop): wire --gui-server stdio branch reusing command registry"
```

### Task 5: Electron main + preload thin chat IPC (drop PTY)

**Files:**
- Modify: `desktop/main.mjs`
- Modify: `desktop/preload.cjs`
- Test: `tests/desktop-chatParity.test.ts` (new; asserts bridge surface, no PTY spawn)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("desktop shell split", () => {
  it("preload exposes chat IPC and no terminal IPC", () => {
    const source = readFileSync("desktop/preload.cjs", "utf8");
    expect(source).toContain("chatSend");
    expect(source).toContain("chatRespond");
    expect(source).toContain("onChatEvent");
    expect(source).not.toContain("startTerminal");
    expect(source).not.toContain("drainTerminal");
  });
  it("main spawns the gui server, not a pty", () => {
    const source = readFileSync("desktop/main.mjs", "utf8");
    expect(source).toContain("--gui-server");
    expect(source).not.toContain("node-pty");
    expect(source).not.toContain("pty.spawn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatParity.test.ts`
Expected: FAIL (preload still exposes `startTerminal`; main still contains `pty.spawn`).

- [ ] **Step 3: Write minimal implementation**

`desktop/preload.cjs` — replace the terminal bridge block with:

```js
chatSend: (request) => ipcRenderer.invoke("cloudcode:chat-send", request),
chatAbort: (id) => ipcRenderer.invoke("cloudcode:chat-abort", id),
chatHistory: (sessionId) => ipcRenderer.invoke("cloudcode:chat-history", sessionId),
chatRespond: (response) => ipcRenderer.invoke("cloudcode:chat-respond", response),
onChatEvent: listener => {
  const callback = (_event, payload) => listener(payload);
  ipcRenderer.on("cloudcode:chat-event", callback);
  return () => ipcRenderer.removeListener("cloudcode:chat-event", callback);
},
```

`desktop/main.mjs` — replace `startTerminal`/`stopTerminal`/drain/write/resize handlers with:

```js
import { spawn } from "node:child_process";
let chatChild;
function startChatBackend() {
  stopChatBackend();
  chatChild = spawn(executable, [cliPath, "--gui-server"], { cwd: projectRoot, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  chatChild.stdout.setEncoding("utf8");
  chatChild.stdout.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.lastIndexOf("\n");
    if (newline === -1) return;
    const complete = buffer.slice(0, newline).split("\n");
    buffer = buffer.slice(newline + 1);
    for (const line of complete) {
      if (!line) continue;
      try { send("cloudcode:chat-event", JSON.parse(line)); } catch { /* malformed child output is ignored */ }
    }
  });
  chatChild.on("exit", () => { chatChild = undefined; });
}
function stopChatBackend() {
  if (!chatChild) return;
  const active = chatChild;
  chatChild = undefined;
  try { active.kill(); } catch { /* already exited */ }
}
ipcMain.handle("cloudcode:chat-send", (_event, request) => {
  if (!chatChild) startChatBackend();
  chatChild?.stdin.write(`${JSON.stringify(request)}\n`);
});
ipcMain.handle("cloudcode:chat-respond", (_event, response) => {
  chatChild?.stdin.write(`${JSON.stringify({ kind: "respond", ...response })}\n`);
});
```

Remove `node-pty` import, `TurnStream` import, `terminalBusy` state, and all `cloudcode:terminal-*` handlers. Git/workspace handlers stay.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-chatParity.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/main.mjs desktop/preload.cjs tests/desktop-chatParity.test.ts
git commit -m "feat(desktop): thin chat IPC over gui-server subprocess"
```

### Task 6: Renderer ChatPane + `/` autocomplete + cleanup

**Files:**
- Create: `desktop/renderer/chatPane.tsx`
- Modify: `desktop/renderer/src.tsx`
- Delete: `desktop/renderer/terminalKeys.ts`, `desktop/renderer/imePosition.ts` (remove imports first)
- Test: `tests/desktop-chatParity.test.ts` (extend: slash-name parity)

**Precondition:** `npm run desktop:build` must pass before this task; renderer changes are verified by build + manual acceptance (vitest environment is node, no jsdom for React).

- [ ] **Step 1: Write the failing parity test**

```ts
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/commands/builtins.js";
import { readFileSync } from "node:fs";

describe("slash parity", () => {
  it("every GUI-visible command is reachable from the chat autocomplete", () => {
    const source = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
    expect(registry.size).toBeGreaterThan(0);
    for (const name of registry.keys()) {
      expect(source, `/${name} missing from chat autocomplete`).toContain(`/${name}`);
    }
  });
});
```

(The registry source of truth is `buildRegistry` in `src/commands/builtins.ts`; the GUI passes `CLOUDCODE_DESKTOP: "1"` so the `exit` command is excluded, matching `visibleCommands`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatParity.test.ts`
Expected: FAIL with "ENOENT: desktop/renderer/chatPane.tsx" (file not created yet).

- [ ] **Step 3: Write minimal implementation**

`desktop/renderer/chatPane.tsx` (new, under 600 lines):

```tsx
import { useEffect, useRef, useState } from "react";
import { buildRegistry } from "../../src/commands/builtins.js";

const SLASH_NAMES = [...buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" }).keys()].map(name => `/${name}`);

type ChatMsg = { id: string; role: "user" | "assistant" | "notice" | "error"; text: string };

export function ChatPane({ sessionId }: { sessionId: string | undefined }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [completions, setCompletions] = useState<string[]>([]);
  const [permission, setPermission] = useState<{ id: string; toolName: string; toolInput?: Record<string, unknown> } | undefined>(undefined);
  const pending = useRef(new Map<string, string>());

  useEffect(() => {
    return window.cloudcode.onChatEvent((event: { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown> }) => {
      if (event.type === "permission_request") {
        setPermission({ id: event.id, toolName: event.toolName ?? "tool", toolInput: event.toolInput });
        return;
      }
      if (event.type === "text_delta" && event.text) {
        setMessages(current => {
          const last = current[current.length - 1];
          if (last?.id === event.id && last.role === "assistant") {
            return [...current.slice(0, -1), { ...last, text: last.text + (event.text ?? "") }];
          }
          return [...current, { id: event.id, role: "assistant", text: event.text ?? "" }];
        });
      } else if ((event.type === "notice" || event.type === "error") && event.text) {
        setMessages(current => [...current, { id: event.id, role: event.type, text: event.text ?? "" }]);
      }
    });
  }, [sessionId]);

  function onChange(value: string) {
    setInput(value);
    if (value.startsWith("/")) {
      setCompletions(SLASH_NAMES.filter(name => name.startsWith(value.split(" ")[0] ?? "")));
    } else {
      setCompletions([]);
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    const id = `${Date.now()}`;
    pending.current.set(id, text);
    setMessages(current => [...current, { id, role: "user", text }]);
    setInput("");
    setCompletions([]);
    void window.cloudcode.chatSend({ id, sessionId, text });
  }

  function abort(id: string) {
    pending.current.delete(id);
    setMessages(current => [...current, { id, role: "notice", text: "Cancelled." }]);
    void window.cloudcode.chatAbort(id);
  }

  function respond(allow: boolean) {
    if (!permission) return;
    void window.cloudcode.chatRespond({ id: permission.id, allow });
    setPermission(undefined);
  }

  return (
    <section className="chat-pane">
      {permission && (
        <div className="permission-overlay" role="alertdialog" aria-label="Permission request">
          <strong>Allow {permission.toolName}?</strong>
          <pre>{JSON.stringify(permission.toolInput ?? {}, null, 2)}</pre>
          <button onClick={() => respond(true)}>Allow</button>
          <button onClick={() => respond(false)}>Deny</button>
        </div>
      )}
      <div className="chat-list" role="log" aria-label="Conversation">
        {messages.map(message => (
          <article key={`${message.id}-${message.role}`} className={`bubble ${message.role}`}>
            <pre>{message.text}</pre>
          </article>
        ))}
      </div>
      {completions.length > 0 && (
        <ul className="slash-complete" aria-label="Slash commands">
          {completions.map(name => <li key={name}><button onClick={() => onChange(name + " ")}>{name}</button></li>)}
        </ul>
      )}
      <div className="chat-input">
        <input aria-label="Message input" value={input} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Message, or / for commands" />
        <button onClick={send}>Send</button>
        {pending.current.size > 0 && <button aria-label="Abort turn" onClick={() => { const ids = [...pending.current.keys()]; const last = ids[ids.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
    </section>
  );
}
```

`desktop/renderer/src.tsx`: replace the xterm `Terminal` setup effect and `<div className="terminal-host">` block with `<ChatPane sessionId={activeSessions[active ?? ""]} />`; delete `terminalKeys`/`imePosition` imports; delete `terminalReady`/`terminalGeneration` state and the 50ms drain poll. Update the `window.cloudcode` interface: remove `terminal-*` entries, add `chatSend/chatAbort/chatHistory/chatRespond/onChatEvent` with the `permission_request` event shape. Keep sidebar, Git inspector, workspace/session switching (now without PTY kill). Backend-crash banner: reuse the existing `terminalExit`-style state slot to show "Backend exited" with a Retry button that re-sends the last pending `chatSend`.

Delete `desktop/renderer/terminalKeys.ts` and `desktop/renderer/imePosition.ts` via `git rm`. Remove `@xterm` imports; leave the `@xterm` npm packages installed (removing dependencies is out of scope for this plan).

- [ ] **Step 4: Run tests and builds**

Run: `npx vitest run tests/desktop-chatParity.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: clean.
Run: `npm run desktop:build`
Expected: clean vite + electron build.
Run: `npm run lint && npm run lint:size`
Expected: clean (new files under 600 lines).

Manual acceptance (record results in PR): CJK IME input, select/copy a bubble, `/` lists all commands, permission overlay allow/deny, session switch mid-turn does not kill backend.

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/chatPane.tsx desktop/renderer/src.tsx desktop/renderer/terminalKeys.ts desktop/renderer/imePosition.ts tests/desktop-chatParity.test.ts
git commit -m "feat(desktop): native chat pane with slash autocomplete"
```

### Task 7: Real engine wiring (replace turn stub with AgentSession)

**Files:**
- Create: `src/desktop/chatEvents.ts`
- Modify: `src/cli.tsx` (guiserver branch: replace `[turn stub]` runner)
- Test: `tests/desktop-chatEvents.test.ts`

**Reference (read before implementing):** `src/agent/session.ts:50-79` (`AgentSessionOptions`), `src/agent/session.ts:246-251` (`send(text)` starts a turn, rejects concurrent turns), `src/engine/messages.ts:16-24` (`EngineMessage` union). Mirror the session construction in `src/ui/nativeApp.ts` (provider load + settings + `onMessage`/`onPermissionRequest` wiring) — do not invent a second construction path.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { toChatEvents } from "../src/desktop/chatEvents.js";

describe("toChatEvents", () => {
  it("maps text deltas and assistant text blocks", () => {
    expect(toChatEvents("7", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } })).toEqual([
      { id: "7", type: "text_delta", text: "hi" },
    ]);
    expect(toChatEvents("7", { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })).toEqual([
      { id: "7", type: "text_delta", text: "hello" },
    ]);
  });
  it("maps tool activity and errors, ignores control messages", () => {
    expect(toChatEvents("7", { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }] } })).toEqual([
      { id: "7", type: "tool_use", toolName: "Read", toolInput: { path: "a" } },
    ]);
    expect(toChatEvents("7", { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false })).toEqual([
      { id: "7", type: "tool_result", text: "ok" },
    ]);
    expect(toChatEvents("7", { type: "result", subtype: "error_during_execution", result: "boom" })).toEqual([
      { id: "7", type: "error", text: "boom" },
    ]);
    expect(toChatEvents("7", { type: "system", subtype: "init", session_id: "s", tools: [] })).toEqual([]);
    expect(toChatEvents("7", { type: "result", subtype: "success", duration_ms: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatEvents.test.ts`
Expected: FAIL with "Cannot find module '../src/desktop/chatEvents.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ChatEvent } from "./chatProtocol.js";
import type { EngineMessage } from "../engine/messages.js";

export function toChatEvents(id: string, msg: EngineMessage): ChatEvent[] {
  switch (msg.type) {
    case "stream_event":
      if (msg.event.delta.type === "text_delta") return [{ id, type: "text_delta", text: msg.event.delta.text }];
      return [];
    case "assistant": {
      const events: ChatEvent[] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") events.push({ id, type: "text_delta", text: block.text });
        else if (block.type === "tool_use") events.push({ id, type: "tool_use", toolName: block.name, toolInput: block.input });
      }
      return events;
    }
    case "tool_result":
      return [{ id, type: "tool_result", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }];
    case "result":
      if (msg.subtype === "error_during_execution") return [{ id, type: "error", text: msg.result }];
      return [];
    case "limit":
      return [{ id, type: "error", text: `Limit reached: ${msg.limit} (${msg.value})` }];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Replace the turn stub in `src/cli.tsx`**

In the `guiserver` branch from Task 4, replace the stub runner with an `AgentSession` per workspace cwd (mirror `src/ui/nativeApp.ts` session construction: `loadProviders()` + `loadSettings()` + `onMessage` mapping each `EngineMessage` through `toChatEvents` into `emit`, plus `onPermissionRequest` emitting `{ id, type: "permission_request", toolName, toolInput }` and resolving on a matching `chatRespond` stdin request `{ kind: "respond", id, allow: boolean }`):

```tsx
const { AgentSession } = await import("./agent/session.js");
const { loadProviders } = await import("./agent/providers.js");
const { loadSettings } = await import("./agent/settings.js");
const pendingPermission = new Map<string, (allow: boolean) => void>();
const sessions = new Map<string, InstanceType<typeof AgentSession>>();
function sessionFor(cwd: string, emit: (event: { id: string; type: string; text?: string }) => void) {
  const existing = sessions.get(cwd);
  if (existing) return existing;
  const settings = loadSettings();
  const providers = loadProviders();
  const providerName = settings.provider ?? "anthropic";
  const provider = providers[providerName] ?? providers.anthropic;
  const session = new AgentSession({
    providerName,
    provider,
    cwd,
    permissionMode: settings.permissionMode ?? "default",
    onMessage: (msg) => { for (const event of toChatEvents(currentId, msg)) emit(event); },
    onPermissionRequest: (req) => {
      pendingPermission.set(currentId, req.resolve);
      emit({ id: currentId, type: "permission_request", toolName: req.toolName, toolInput: req.input });
    },
    onSessionId: () => {},
  });
  session.start();
  sessions.set(cwd, session);
  return session;
}
```

`currentId` is the in-flight request id captured per `handle()` call. The stdin loop additionally accepts `{ kind: "respond", id, allow }` lines and calls `pendingPermission.get(id)?.(allow)`. Keep the `GuiServer` slash path from Task 3 unchanged; only non-slash prompts reach `sessionFor(cwd, emit).send(text)`. Abort maps to the session abort in `src/agent/session.ts:374` (`abort()` method).

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/desktop-chatEvents.test.ts tests/desktop-guiServer.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/desktop/chatEvents.ts src/cli.tsx tests/desktop-chatEvents.test.ts
git commit -m "feat(desktop): wire gui-server turns through AgentSession"
```

---

## Verification checklist (end of plan)

- [ ] `npm run build` clean (headless server ships in `dist/`).
- [ ] `npx vitest run` fully green, including the three new desktop test files.
- [ ] `npm run lint` and `npm run lint:size` clean.
- [ ] `npm run desktop:build` + `npm run desktop:start`: send chat, run `/model`, CJK IME works, bubble text selectable, permission prompt is a native overlay, session switch keeps backend alive.
- [ ] `git status` shows zero modifications under `src/ui/` (TUI untouched).
- [ ] Version bumped per AGENTS.md (patch in `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`) in each commit that lands.
