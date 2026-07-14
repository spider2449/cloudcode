# /effort Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `/effort <off|low|medium|high>` command that maps named levels to Anthropic extended-thinking budgets, streams thinking as dim text, and persists the setting.

**Architecture:** A shared `effort.ts` module defines levels/budgets. `EngineLoop` adds the `thinking` request param and handles `thinking` stream blocks. The setting persists in `settings.json`, plumbs through `AgentSession` → `EngineLoop` like `model`, and is exposed via a new `/effort` command plus a `/config` key. Both UIs (React `App.tsx` and hand-rolled `nativeApp.ts`) stream thinking deltas into a dim live-region text that is never committed to scrollback.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Anthropic Messages API streaming, vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-effort-command-design.md`

## Global Constraints

- All code comments in English (user rule).
- Levels/budgets: `off` = disabled, `low` = 4096, `medium` = 16384, `high` = 32768.
- Default level is `off` — behavior unchanged unless the user opts in.
- Run tests with `npx vitest run <file>`; full suite `npx vitest run`; typecheck `npx tsc --noEmit`.
- Commit after each task.

---

### Task 1: Effort levels module + settings persistence

**Files:**
- Create: `src/engine/effort.ts`
- Modify: `src/agent/settings.ts`
- Test: `tests/settings.test.ts` (append), `tests/effort.test.ts` (create)

**Interfaces:**
- Produces: `EFFORT_LEVELS: readonly ["off","low","medium","high"]`, `type EffortLevel`, `EFFORT_BUDGETS: Record<Exclude<EffortLevel,"off">, number>`, `isEffortLevel(v: unknown): v is EffortLevel` from `src/engine/effort.js`; `Settings.effort?: EffortLevel`.

- [ ] **Step 1: Write failing tests**

Create `tests/effort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS, EFFORT_BUDGETS, isEffortLevel } from "../src/engine/effort.js";

describe("effort", () => {
  it("defines the four levels", () => {
    expect(EFFORT_LEVELS).toEqual(["off", "low", "medium", "high"]);
  });
  it("maps budgets per spec", () => {
    expect(EFFORT_BUDGETS).toEqual({ low: 4096, medium: 16384, high: 32768 });
  });
  it("validates level strings", () => {
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("max")).toBe(false);
    expect(isEffortLevel(42)).toBe(false);
  });
});
```

Append to `tests/settings.test.ts` (inside the existing top-level `describe`, following its temp-file pattern — look at how existing tests build a `filePath` and reuse it):

```ts
it("round-trips effort and rejects invalid values", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
  saveSetting("effort", "medium", file);
  expect(loadSettings(file).effort).toBe("medium");
  saveSetting("effort", "extreme", file);
  expect(loadSettings(file).effort).toBeUndefined();
});
```

(If `mkdtempSync`/`tmpdir`/`join` are not already imported in that test file, add the `node:fs`/`node:os`/`node:path` imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/effort.test.ts tests/settings.test.ts`
Expected: FAIL — cannot resolve `src/engine/effort.js`; `effort` property missing.

- [ ] **Step 3: Implement**

Create `src/engine/effort.ts`:

```ts
// Named reasoning-effort levels mapped to Anthropic extended-thinking budgets.
export const EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_BUDGETS: Record<Exclude<EffortLevel, "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768
};

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}
```

In `src/agent/settings.ts`:
- Add import: `import { isEffortLevel, type EffortLevel } from "../engine/effort.js";`
- Add to `Settings`: `effort?: EffortLevel;`
- In `loadSettings`, after the `permissionMode` check, add:

```ts
  if (isEffortLevel(raw.effort)) out.effort = raw.effort;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/effort.test.ts tests/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/effort.ts src/agent/settings.ts tests/effort.test.ts tests/settings.test.ts
git commit -m "feat: add effort levels module and settings persistence"
```

---

### Task 2: Engine message types for thinking

**Files:**
- Modify: `src/engine/messages.ts`
- Test: `tests/engine-messages.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ContentBlock` union gains `{ type: "thinking"; thinking: string; signature: string }`; `EngineMessage` stream_event delta union gains `{ type: "thinking_delta"; thinking: string }`; new factory `thinkingDelta(thinking: string): EngineMessage`.

- [ ] **Step 1: Write failing test**

Append to `tests/engine-messages.test.ts`:

```ts
import { thinkingDelta } from "../src/engine/messages.js";

describe("thinkingDelta", () => {
  it("wraps thinking text in a stream_event", () => {
    expect(thinkingDelta("hmm")).toEqual({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }
    });
  });
});
```

(Merge the import into the file's existing import from `../src/engine/messages.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-messages.test.ts`
Expected: FAIL — `thinkingDelta` is not exported.

- [ ] **Step 3: Implement**

In `src/engine/messages.ts`:

```ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
```

Change the `stream_event` member of `EngineMessage` to:

```ts
  | { type: "stream_event"; event: { type: "content_block_delta"; delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } } }
```

Add factory:

```ts
export function thinkingDelta(thinking: string): EngineMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/engine-messages.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors (`streamDelta` in `transcript.ts` narrows on `delta.type === "text_delta"` so it still compiles).

- [ ] **Step 5: Commit**

```bash
git add src/engine/messages.ts tests/engine-messages.test.ts
git commit -m "feat: add thinking content block and thinking_delta engine message"
```

---

### Task 3: EngineLoop thinking support

**Files:**
- Modify: `src/engine/loop.ts`, `src/engine/api.ts`
- Test: `tests/engine-loop.test.ts` (append)

**Interfaces:**
- Consumes: `EFFORT_BUDGETS`, `EffortLevel` from Task 1; `thinkingDelta` and thinking `ContentBlock` from Task 2.
- Produces: `EngineOptions.effort?: EffortLevel`; `EngineLoop.setEffort(level: EffortLevel): void`; requests carry `thinking: { type: "enabled"; budget_tokens }` and raised `max_tokens` when effort ≠ off; thinking blocks preserved in `loop.messages`.

- [ ] **Step 1: Write failing tests**

Append to `tests/engine-loop.test.ts`. First add a request-capturing fake client and a thinking turn script near the existing helpers:

```ts
// Captures each request passed to create() so tests can assert on the
// thinking parameter and max_tokens.
function capturingClient(turns: object[][], requests: unknown[]) {
  let call = 0;
  return {
    async *create(req: unknown) {
      requests.push(req);
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

const thinkingTurn = (thinking: string, text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];
```

Then the tests:

```ts
describe("EngineLoop thinking", () => {
  function makeEffortLoop(turns: object[][], received: unknown[], requests: unknown[], effort: "off" | "low" | "medium" | "high") {
    return new EngineLoop({
      client: capturingClient(turns, requests),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-"))),
      effort,
      onMessage: m => received.push(m),
      requestPermission: async () => true
    });
  }

  it("omits thinking param when effort is off", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("hi")], [], requests, "off");
    await loop.runTurn("q", new AbortController().signal);
    const req = requests[0] as { thinking?: unknown; max_tokens: number };
    expect(req.thinking).toBeUndefined();
    expect(req.max_tokens).toBe(8192);
  });

  it("sends thinking budget and raised max_tokens when effort is medium", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("hi")], [], requests, "medium");
    await loop.runTurn("q", new AbortController().signal);
    const req = requests[0] as { thinking?: unknown; max_tokens: number };
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(req.max_tokens).toBe(16384 + 8192);
  });

  it("setEffort applies to the next request", async () => {
    const requests: unknown[] = [];
    const loop = makeEffortLoop([textTurn("a"), textTurn("b")], [], requests, "off");
    await loop.runTurn("q1", new AbortController().signal);
    loop.setEffort("high");
    await loop.runTurn("q2", new AbortController().signal);
    expect((requests[1] as { thinking?: unknown }).thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
  });

  it("accumulates thinking blocks with signature into history and emits thinking deltas", async () => {
    const received: unknown[] = [];
    const requests: unknown[] = [];
    const loop = makeEffortLoop([thinkingTurn("let me think", "answer")], received, requests, "low");
    await loop.runTurn("q", new AbortController().signal);
    const assistant = loop.messages[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "let me think", signature: "sig123" });
    expect(assistant.content[1]).toEqual({ type: "text", text: "answer" });
    const thinkingMsgs = received.filter(m =>
      (m as { event?: { delta?: { type?: string } } }).event?.delta?.type === "thinking_delta");
    expect(thinkingMsgs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: FAIL — `effort` not in `EngineOptions`, `setEffort` missing, thinking block not accumulated.

- [ ] **Step 3: Implement**

In `src/engine/api.ts`, add to `StreamRequest`:

```ts
  thinking?: { type: "enabled"; budget_tokens: number };
```

In `src/engine/loop.ts`:
- Imports: `import { EFFORT_BUDGETS, type EffortLevel } from "./effort.js";` and add `thinkingDelta` to the import from `./messages.js`.
- Add to `EngineOptions`: `effort?: EffortLevel;`
- In `EngineLoop`: field `private effort: EffortLevel;`, initialize in constructor `this.effort = opts.effort ?? "off";`, and method:

```ts
  setEffort(level: EffortLevel): void {
    this.effort = level;
  }
```

- In `streamOnce`, build the request with the thinking param. Replace the `req` literal with:

```ts
    // With extended thinking enabled, budget_tokens counts against
    // max_tokens, so raise the cap to keep MAX_TOKENS available for the
    // visible answer.
    const budget = this.effort === "off" ? undefined : EFFORT_BUDGETS[this.effort];
    const req = {
      model: this.model,
      system: [{ type: "text" as const, text: this.opts.systemPrompt, cache_control: { type: "ephemeral" as const } }],
      messages: withCacheControlOnLastBlock(this.messages),
      tools: this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: budget === undefined ? MAX_TOKENS : budget + MAX_TOKENS,
      ...(budget === undefined ? {} : { thinking: { type: "enabled" as const, budget_tokens: budget } })
    };
```

- In the stream handler, extend `content_block_start` (the `cb` type annotation gains `thinking?: string`):

```ts
        if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
        else if (cb.type === "thinking") blocks.push({ type: "thinking", thinking: cb.thinking ?? "", signature: "" });
        else if (cb.type === "tool_use") {
          blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
        }
```

- Extend `content_block_delta` (the `delta` type annotation gains `thinking?: string; signature?: string`):

```ts
        } else if (delta.type === "thinking_delta" && last?.type === "thinking") {
          last.thinking += delta.thinking ?? "";
          this.opts.onMessage(thinkingDelta(delta.thinking ?? ""));
        } else if (delta.type === "signature_delta" && last?.type === "thinking") {
          last.signature += delta.signature ?? "";
        } else if (delta.type === "input_json_delta" && last?.type === "tool_use") {
```

(Thinking blocks land in `turn.blocks`, which `runTurn` already pushes into `this.messages` verbatim — so history, session save/load, and compaction carry them with no further changes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-loop.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts src/engine/api.ts tests/engine-loop.test.ts
git commit -m "feat: extended-thinking support in engine loop via effort levels"
```

---

### Task 4: Session plumbing + /effort command + /config key

**Files:**
- Modify: `src/agent/session.ts`, `src/commands/types.ts`, `src/commands/builtins.ts`
- Modify: `src/ui/App.tsx`, `src/ui/nativeApp.ts` (CommandContext implementations)
- Test: `tests/commands.test.ts` (append + update)

**Interfaces:**
- Consumes: `EngineLoop.setEffort`, `EngineOptions.effort` (Task 3); `EFFORT_LEVELS`, `isEffortLevel`, `EffortLevel` (Task 1).
- Produces: `AgentSessionOptions.effort?: EffortLevel`; `AgentSession.setEffort(level): Promise<void>`; `CommandContext.setEffort(level: EffortLevel): Promise<void>` and `CommandContext.currentEffort(): EffortLevel`; `/effort` command; `effort` key in `/config`.

- [ ] **Step 1: Write failing tests**

In `tests/commands.test.ts`:

1. In `mockCtx()` add:

```ts
    setEffort: vi.fn().mockResolvedValue(undefined),
    currentEffort: vi.fn().mockReturnValue("off"),
```

2. In the `registers all v1 commands` test, add `"effort"` to the sorted expected array (between `"cost"` and `"exit"`).

3. Add a describe block (follow the file's existing style for invoking commands):

```ts
describe("/effort", () => {
  const run = async (args: string, ctx = mockCtx()) => {
    const cmd = buildRegistry().get("effort")!;
    await cmd.run(ctx, args);
    return ctx;
  };

  it("lists levels with current marked when no args", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.currentEffort).mockReturnValue("medium");
    await run("", ctx);
    expect(ctx.notice).toHaveBeenCalledWith("  off\n  low\n● medium\n  high");
  });

  it("sets and persists a valid level", async () => {
    const ctx = await run("high");
    expect(saveSetting).toHaveBeenCalledWith("effort", "high");
    expect(ctx.setEffort).toHaveBeenCalledWith("high");
    expect(ctx.notice).toHaveBeenCalledWith("Effort: high");
  });

  it("rejects unknown levels", async () => {
    const ctx = await run("extreme");
    expect(ctx.setEffort).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown level: extreme. Levels: off, low, medium, high");
  });

  it("completes level names", () => {
    const cmd = buildRegistry().get("effort")!;
    expect(cmd.completeArgs!("m", {} as never)).toEqual(["medium"]);
  });
});
```

4. If the file has a `/config` completion/keys test, extend its expected keys with `effort`; also add:

```ts
it("config sets effort", async () => {
  const cmd = buildRegistry().get("config")!;
  const ctx = mockCtx();
  await cmd.run(ctx, "effort low");
  expect(saveSetting).toHaveBeenCalledWith("effort", "low");
  expect(ctx.setEffort).toHaveBeenCalledWith("low");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — no `effort` command; `setEffort` missing from `CommandContext`.

- [ ] **Step 3: Implement**

`src/agent/session.ts`:
- Import: `import type { EffortLevel } from "../engine/effort.js";`
- Add to `AgentSessionOptions`: `effort?: EffortLevel;`
- In `start()`, pass `effort: this.opts.effort,` into the `new EngineLoop({...})` options.
- Add method next to `setModel`:

```ts
  async setEffort(level: EffortLevel): Promise<void> {
    this.loop?.setEffort(level);
  }
```

`src/commands/types.ts`:
- Import: `import type { EffortLevel } from "../engine/effort.js";`
- Add to `CommandContext`:

```ts
  setEffort(level: EffortLevel): Promise<void>;
  currentEffort(): EffortLevel;
```

`src/commands/builtins.ts`:
- Import: `import { EFFORT_LEVELS, isEffortLevel } from "../engine/effort.js";`
- Change `CONFIG_KEYS` to `["provider", "model", "permissionMode", "theme", "effort"] as const;`
- In `configValue`, return the loaded setting for effort:

```ts
function configValue(key: ConfigKey): string {
  if (key === "theme") return loadThemeName();
  if (key === "effort") return loadSettings().effort ?? "off";
  return loadSettings()[key as keyof Omit<Settings, "effort">] ?? "(unset)";
}
```

- In `/config`'s `switch`, add before `case "theme"`:

```ts
        case "effort":
          if (!isEffortLevel(value)) {
            ctx.notice(`Unknown level: ${value}. Levels: ${EFFORT_LEVELS.join(", ")}`);
            return;
          }
          saveSetting("effort", value);
          await ctx.setEffort(value);
          break;
```

- In `/config`'s `completeArgs` value table, add: `key === "effort" ? EFFORT_LEVELS :` (spread as `[...EFFORT_LEVELS]` if the readonly tuple type complains).
- Add the command (alphabetical spot, after `cost`):

```ts
  {
    name: "effort",
    description: "Set reasoning effort: /effort <off|low|medium|high>; no arg lists levels",
    async run(ctx, args) {
      if (!args) {
        const current = ctx.currentEffort();
        ctx.notice(EFFORT_LEVELS.map(l => `${l === current ? "●" : " "} ${l}`).join("\n"));
        return;
      }
      if (!isEffortLevel(args)) {
        ctx.notice(`Unknown level: ${args}. Levels: ${EFFORT_LEVELS.join(", ")}`);
        return;
      }
      saveSetting("effort", args);
      await ctx.setEffort(args);
      ctx.notice(`Effort: ${args}`);
    },
    completeArgs(prefix) {
      return EFFORT_LEVELS.filter(l => l.startsWith(prefix));
    }
  },
```

`src/ui/nativeApp.ts`:
- Imports: `loadSettings` from `../agent/settings.js` (if not already imported) and `import type { EffortLevel } from "../engine/effort.js";`
- Field near `private model...`: `private effort: EffortLevel = loadSettings().effort ?? "off";`
- In `createSession`, pass `effort: this.effort,` into `new AgentSession({...})`.
- In `buildCommandContext()`, next to `setModel`:

```ts
      setEffort: async level => { await this.session?.setEffort(level); this.effort = level; },
      currentEffort: () => this.effort,
```

`src/ui/App.tsx`:
- Imports: `loadSettings` from `../agent/settings.js` (if not already imported) and `import type { EffortLevel } from "../engine/effort.js";`
- State near `model`: `const effortRef = useRef<EffortLevel>(loadSettings().effort ?? "off");`
- In `createSession`, pass `effort: effortRef.current,` into `new AgentSession({...})`.
- In the `CommandContext` object next to `setModel`:

```ts
    setEffort: async level => { await sessionRef.current?.setEffort(level); effortRef.current = level; },
    currentEffort: () => effortRef.current,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts && npx tsc --noEmit`
Expected: PASS. If other test files construct a `CommandContext` literal (e.g. `tests/completion.test.ts`, `tests/app.test.tsx`), add the two new mock members there too; run `npx vitest run` to catch them.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts src/commands/types.ts src/commands/builtins.ts src/ui/App.tsx src/ui/nativeApp.ts tests/commands.test.ts
git commit -m "feat: add /effort command with persistence and config key"
```

---

### Task 5: Dim thinking stream in both UIs

**Files:**
- Modify: `src/ui/transcript.ts`, `src/ui/nativeApp.ts`, `src/ui/term/render.ts`, `src/ui/App.tsx`
- Test: `tests/transcript.test.ts` (append), `tests/render.test.ts` (append)

**Interfaces:**
- Consumes: `thinking_delta` stream events (Task 3).
- Produces: `streamThinkingDelta(msg: EngineMessage): string | undefined` in `transcript.ts`; `BottomState.thinkingText: string` in `render.ts`.

Behavior: thinking streams live in the footer region as dim text while the model reasons; it is cleared (never committed to scrollback) as soon as answer text starts, an assistant message lands, or the turn ends.

- [ ] **Step 1: Write failing tests**

Append to `tests/transcript.test.ts`:

```ts
import { streamThinkingDelta } from "../src/ui/transcript.js";
import { thinkingDelta, textDelta } from "../src/engine/messages.js";

describe("streamThinkingDelta", () => {
  it("extracts thinking text", () => {
    expect(streamThinkingDelta(thinkingDelta("hmm"))).toBe("hmm");
  });
  it("ignores text deltas and other messages", () => {
    expect(streamThinkingDelta(textDelta("hi"))).toBeUndefined();
    expect(streamThinkingDelta({ type: "result", subtype: "error_during_execution", result: "x" })).toBeUndefined();
  });
});
```

(Merge imports with any existing ones from the same modules.)

Append to `tests/render.test.ts`, following how existing tests in that file build a `BottomState` (they likely share a helper — add `thinkingText: ""` to it, then):

```ts
it("renders thinkingText dim above the stream text", () => {
  const out = frameWith({ thinkingText: "pondering...", streamingText: "" });
  expect(out).toContain("\x1b[2mpondering...\x1b[22m");
});
```

(`frameWith` here means: construct the same `InlineRenderer.frame(...)` call the file's other tests use, overriding the named `BottomState` fields. Adapt to the file's actual helper.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transcript.test.ts tests/render.test.ts`
Expected: FAIL — `streamThinkingDelta` not exported; `thinkingText` missing from `BottomState`.

- [ ] **Step 3: Implement**

`src/ui/transcript.ts` — add next to `streamDelta`:

```ts
export function streamThinkingDelta(msg: EngineMessage): string | undefined {
  const m = msg as Record<string, unknown>;
  if (m.type !== "stream_event") return undefined;
  const event = m.event as { type?: string; delta?: { type?: string; thinking?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
    return event.delta.thinking;
  }
  return undefined;
}
```

`src/ui/term/render.ts`:
- Add `thinkingText: string;` to `BottomState`.
- In `frame()`, before the `streamingText` section, render the thinking tail dim (thinking sits above answer text, capped small so it never dominates the footer):

```ts
    if (bottom.thinkingText !== "") {
      const thinkTailCap = Math.max(2, Math.min(6, rows - dyn.length - 3));
      dyn.unshift(...tailForHeight(bottom.thinkingText, thinkTailCap, columns)
        .split("\n").map(l => `\x1b[2m${l}\x1b[22m`));
    }
```

`src/ui/nativeApp.ts`:
- Field near `streamText`: `private thinkingText = "";`
- Import `streamThinkingDelta` from `./transcript.js`.
- In `handleMessage`, before the existing `streamDelta` check:

```ts
    const thinking = streamThinkingDelta(msg);
    if (thinking) { this.thinkingText += thinking; this.recompute(); return; }
```

- In the existing `streamDelta` branch, clear thinking when answer text starts: `if (delta) { this.thinkingText = ""; this.streamText += delta; this.recompute(); return; }`
- Where `streamText` is reset on assistant/result (lines with `this.streamText = ""`), also set `this.thinkingText = "";`. Same in `clearSession` in `buildCommandContext`.
- Where the `BottomState` object is built (in `recompute`/render call), pass `thinkingText: this.thinkingText,`.

`src/ui/App.tsx`:
- Add `thinkingText: string` to `LiveState` (init `""` in the `useState` default) and a `thinkingRef = useRef("")` beside `streamRef`.
- In `handleMessage`, before the `streamDelta` check:

```ts
    const thinking = streamThinkingDelta(msg);
    if (thinking) { thinkingRef.current += thinking; patchLive({ thinkingText: thinkingRef.current }); return; }
```

- When a text delta arrives, clear it: in the `if (delta)` branch, first `if (thinkingRef.current) { thinkingRef.current = ""; patchLive({ thinkingText: "" }); }` (or fold into one `patchLive`).
- Everywhere `streamText: ""` is patched (assistant mapped, result, interrupt at line ~319, clearSession), also patch `thinkingText: ""` and reset `thinkingRef.current = ""`.
- In the JSX next to the `streamText` block (line ~555), render above it:

```tsx
          {thinkingText !== "" && (
            <Box>
              <Text dimColor wrap="wrap">
                {tailForHeight(thinkingText, 6, termSize.columns)}
              </Text>
            </Box>
          )}
```

(Destructure `thinkingText` from `live` alongside `phase, streamText, activeTool`. If the live-region row math (`streamRowsFloor` at line ~457) needs it, add its rows the same way `streamText` rows are counted, capped at 6.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcript.test.ts tests/render.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all tests PASS (fix any `BottomState` literals in other tests missing `thinkingText`).

- [ ] **Step 6: Commit**

```bash
git add src/ui/transcript.ts src/ui/term/render.ts src/ui/nativeApp.ts src/ui/App.tsx tests/transcript.test.ts tests/render.test.ts
git commit -m "feat: stream thinking as dim live text in both UIs"
```

---

### Task 6: End-to-end verification

**Files:**
- No new files; manual/automated verification only.

- [ ] **Step 1: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 2: Manual smoke test**

Run the app (`npm start` or the project's run command) against a real Anthropic provider:
1. `/effort` → lists four levels, `●` on `off`.
2. `/effort medium` → notice `Effort: medium`; check `~/.cloudcode/settings.json` contains `"effort": "medium"`.
3. Ask a question that requires reasoning → dim thinking text streams, then the answer replaces it; thinking is absent from scrollback.
4. Ask a follow-up that triggers a tool call → no API error (thinking blocks with signatures round-trip in history).
5. `/effort off` → next turn sends no thinking; behavior as before.
6. Restart the app → `/effort` shows `●` on `medium`... wait, it was set to `off` in step 5, so `●` on `off`; set `medium` again, restart, confirm `●` on `medium`.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in /effort end-to-end verification"
```

(Skip the commit if nothing changed.)
