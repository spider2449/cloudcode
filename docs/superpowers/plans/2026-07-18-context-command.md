# /context Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/context` builtin that prints a per-category context-usage breakdown (system prompt, tools, messages, free space) against the model's context window.

**Architecture:** `EngineLoop` records a `ContextSnapshot` (chars/4 estimates per request component plus the real `input_tokens` from usage) each time it builds an API request. A new `CommandContext.contextInfo()` surfaces the snapshot plus model name and context window from `nativeApp`, and a new `/context` command in `builtins.ts` formats the table.

**Tech Stack:** TypeScript (Node ESM, `.js` import suffixes), vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-context-command-design.md`

## Global Constraints

- All code, comments, and identifiers in English only.
- Follow existing import style: relative imports end in `.js`.
- Run tests with `npx vitest run <file>`.

---

### Task 1: ContextSnapshot in EngineLoop

**Files:**
- Modify: `src/engine/loop.ts`
- Test: `tests/engine-loop.test.ts`

**Interfaces:**
- Produces: exported `interface ContextSnapshot { systemTokens: number; toolsTokens: number; messagesTokens: number; inputTokens?: number }` and `EngineLoop.contextSnapshot(): ContextSnapshot`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine-loop.test.ts` (reuse the existing `fakeClient`, `textTurnWithMessageStart`, and the file's existing pattern for constructing an `EngineLoop` — copy the constructor options from a neighboring test, e.g. `new EngineLoop({ client, model: "m", systemPrompt: "You are a test agent.", tools: [echoTool], cwd: "/tmp", permissionMode: "bypassPermissions", store, onMessage: () => {}, requestPermission: async () => true })` with `store = new PermissionStore(mkdtempSync(join(tmpdir(), "ctx-")))`):

```ts
describe("contextSnapshot", () => {
  it("estimates from current state before any turn", () => {
    const store = new PermissionStore(mkdtempSync(join(tmpdir(), "ctx-")));
    const loop = new EngineLoop({
      client: fakeClient([]), model: "m", systemPrompt: "abcd".repeat(10),
      tools: [echoTool], cwd: "/tmp", permissionMode: "bypassPermissions",
      store, onMessage: () => {}, requestPermission: async () => true
    });
    const snap = loop.contextSnapshot();
    expect(snap.systemTokens).toBe(10); // 40 chars / 4
    expect(snap.toolsTokens).toBeGreaterThan(0);
    expect(snap.messagesTokens).toBe(Math.ceil(JSON.stringify([]).length / 4));
    expect(snap.inputTokens).toBeUndefined();
  });

  it("records real input tokens after a turn, including cache fields", async () => {
    const store = new PermissionStore(mkdtempSync(join(tmpdir(), "ctx-")));
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" }
    ];
    const loop = new EngineLoop({
      client: fakeClient([events]), model: "m", systemPrompt: "sys",
      tools: [], cwd: "/tmp", permissionMode: "bypassPermissions",
      store, onMessage: () => {}, requestPermission: async () => true
    });
    await loop.runTurn("hello", new AbortController().signal);
    const snap = loop.contextSnapshot();
    expect(snap.inputTokens).toBe(1050); // 100 + 900 + 50
    expect(snap.messagesTokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: FAIL — `loop.contextSnapshot is not a function`.

- [ ] **Step 3: Implement in `src/engine/loop.ts`**

Add the exported interface near the top (after `StreamedTurn`):

```ts
export interface ContextSnapshot {
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  inputTokens?: number;
}

const estimate = (text: string) => Math.ceil(text.length / 4);
```

Add a private field to `EngineLoop`:

```ts
private lastSnapshot: ContextSnapshot | undefined;
```

In `streamOnce`, right after the `const req = { ... }` object is built (loop.ts:183-190), record the estimates:

```ts
this.lastSnapshot = {
  systemTokens: estimate(this.systemPrompt),
  toolsTokens: estimate(JSON.stringify(req.tools)),
  messagesTokens: estimate(JSON.stringify(req.messages)),
  inputTokens: this.lastSnapshot?.inputTokens
};
```

At the end of `streamOnce`, just before `return { blocks, stopReason, usage };`, fill in the real total:

```ts
if (usage && this.lastSnapshot) {
  this.lastSnapshot.inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
}
```

Add the public method:

```ts
contextSnapshot(): ContextSnapshot {
  if (this.lastSnapshot) return this.lastSnapshot;
  return {
    systemTokens: estimate(this.systemPrompt),
    toolsTokens: estimate(JSON.stringify(this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })))),
    messagesTokens: estimate(JSON.stringify(this.messages))
  };
}
```

Note: if `Usage` in `src/engine/messages.js` lacks `cache_read_input_tokens` / `cache_creation_input_tokens`, check its definition first — `nativeApp.ts:212` already reads those fields from `usage`, so they exist somewhere; match that typing rather than casting.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: PASS (all tests in file, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts tests/engine-loop.test.ts
git commit -m "feat(engine): record context snapshot per API request"
```

---

### Task 2: Wire contextInfo through Session and CommandContext

**Files:**
- Modify: `src/agent/session.ts`
- Modify: `src/commands/types.ts`
- Modify: `src/ui/nativeApp.ts`
- Test: `tests/commands.test.ts` (mock update only, in this task)

**Interfaces:**
- Consumes: `EngineLoop.contextSnapshot(): ContextSnapshot` from Task 1.
- Produces: `Session.contextSnapshot(): ContextSnapshot | undefined`; `CommandContext.contextInfo(): { snapshot: ContextSnapshot | undefined; model: string; contextWindow: number }`.

- [ ] **Step 1: Add passthrough on Session**

In `src/agent/session.ts`, next to `compact()` (session.ts:154), add:

```ts
contextSnapshot(): ContextSnapshot | undefined {
  return this.loop?.contextSnapshot();
}
```

Import the type: add `ContextSnapshot` to the existing import from `../engine/loop.js` (`import { EngineLoop, type ContextSnapshot } from "../engine/loop.js";`).

- [ ] **Step 2: Extend CommandContext**

In `src/commands/types.ts`, add to the interface (and add `import type { ContextSnapshot } from "../engine/loop.js";` at the top):

```ts
contextInfo(): { snapshot: ContextSnapshot | undefined; model: string; contextWindow: number };
```

- [ ] **Step 3: Implement in nativeApp**

In `src/ui/nativeApp.ts`, inside the object literal where `costSummary` is defined (nativeApp.ts:369), add (import `ContextSnapshot` type only if needed — inference usually suffices):

```ts
contextInfo: () => ({
  snapshot: this.session?.contextSnapshot(),
  model: this.modelFor(this.providerName) ?? "unknown",
  contextWindow: this.contextWindowFor(this.providerName)
}),
```

- [ ] **Step 4: Update the mockCtx in tests/commands.test.ts**

Add to `mockCtx()` (tests/commands.test.ts:25):

```ts
contextInfo: vi.fn().mockReturnValue({
  snapshot: { systemTokens: 1000, toolsTokens: 3000, messagesTokens: 6000, inputTokens: 20000 },
  model: "claude-sonnet-5",
  contextWindow: 200_000
}),
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit` (or the repo's build script if `tsc` isn't configured standalone — check `package.json` scripts) and `npx vitest run`
Expected: no type errors; all tests PASS (mockCtx now satisfies the widened interface).

- [ ] **Step 6: Commit**

```bash
git add src/agent/session.ts src/commands/types.ts src/ui/nativeApp.ts tests/commands.test.ts
git commit -m "feat: expose contextInfo through session and command context"
```

---

### Task 3: /context builtin command

**Files:**
- Modify: `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `ctx.contextInfo()` from Task 2.
- Produces: `/context` command registered in the builtins array; output via `ctx.notice`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/commands.test.ts` (the file already has `buildRegistry` imported; run a command via `registry` the same way neighboring tests do — find `/help` or `/cost` test for the invocation pattern, typically `await buildRegistry().get("context")!.run(ctx, "")`):

```ts
describe("/context", () => {
  it("prints a scaled category breakdown with real usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("context")!.run(ctx, "");
    const out = vi.mocked(ctx.notice).mock.calls[0][0];
    // header: real total 20k of 200k = 10%
    expect(out).toContain("claude-sonnet-5");
    expect(out).toContain("20.0k / 200.0k tokens (10%)");
    // estimates 1k/3k/6k scale by 20000/10000 = 2x -> 2k/6k/12k
    expect(out).toMatch(/System prompt\s+2\.0k\s+1\.0%/);
    expect(out).toMatch(/Tools\s+6\.0k\s+3\.0%/);
    expect(out).toMatch(/Messages\s+12\.0k\s+6\.0%/);
    expect(out).toMatch(/Free space\s+180\.0k\s+90\.0%/);
  });

  it("labels output as estimated when no real usage exists", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.contextInfo).mockReturnValue({
      snapshot: { systemTokens: 1000, toolsTokens: 3000, messagesTokens: 6000 },
      model: "claude-sonnet-5",
      contextWindow: 200_000
    });
    await buildRegistry().get("context")!.run(ctx, "");
    const out = vi.mocked(ctx.notice).mock.calls[0][0];
    expect(out).toContain("(estimated)");
    expect(out).toMatch(/System prompt\s+1\.0k/);
  });

  it("handles a missing snapshot", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.contextInfo).mockReturnValue({ snapshot: undefined, model: "m", contextWindow: 200_000 });
    await buildRegistry().get("context")!.run(ctx, "");
    expect(vi.mocked(ctx.notice).mock.calls[0][0]).toContain("No context yet");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — registry has no "context" command (`.get("context")` undefined).

- [ ] **Step 3: Implement the command in `src/commands/builtins.ts`**

Add a formatter near the top of the file and the command in the `commands` array (alphabetically near `compact`/`config`):

```ts
function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

function contextReport(info: ReturnType<CommandContext["contextInfo"]>): string {
  const { snapshot, model, contextWindow } = info;
  if (!snapshot) return "No context yet — send a message first.";
  const estimateSum = snapshot.systemTokens + snapshot.toolsTokens + snapshot.messagesTokens;
  const real = snapshot.inputTokens;
  const scale = real !== undefined && estimateSum > 0 ? real / estimateSum : 1;
  const total = real ?? estimateSum;
  const rows: Array<[string, number]> = [
    ["System prompt", Math.round(snapshot.systemTokens * scale)],
    ["Tools", Math.round(snapshot.toolsTokens * scale)],
    ["Messages", Math.round(snapshot.messagesTokens * scale)],
    ["Free space", Math.max(0, contextWindow - total)]
  ];
  const pct = (n: number) => `${Math.min(100, Math.max(0, (n / contextWindow) * 100)).toFixed(1)}%`;
  const totalPct = Math.min(100, Math.round((total / contextWindow) * 100));
  const suffix = real === undefined ? " (estimated)" : "";
  const header = `Context usage — ${model} (${fmtK(total)} / ${fmtK(contextWindow)} tokens (${totalPct}%))${suffix}`;
  const body = rows
    .map(([label, n]) => `  ${label.padEnd(15)}${fmtK(n).padStart(7)}  ${pct(n).padStart(5)}`)
    .join("\n");
  return `${header}\n\n${body}`;
}
```

```ts
{
  name: "context",
  description: "Show context window usage breakdown",
  async run(ctx) {
    ctx.notice(contextReport(ctx.contextInfo()));
  }
},
```

Note: the test asserts the substring `20.0k / 200.0k tokens (10%)` — make sure the header format produces exactly that (adjust parentheses so the substring matches, e.g. `(${fmtK(total)} / ${fmtK(contextWindow)} tokens (${totalPct}%))` yields `(20.0k / 200.0k tokens (10%))`, which contains the asserted substring).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite and typecheck**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat: add /context command showing context usage breakdown"
```

---

### Task 4: Manual verification

**Files:** none modified.

- [ ] **Step 1: Launch the app and verify end-to-end**

Run the app (check `package.json` for the start/dev script, e.g. `npm run dev` or `node dist/...`), send one short message, then type `/context`.
Expected: table appears with a real total matching the status bar's token count order-of-magnitude, categories sum to the header total, free space fills the remainder.

- [ ] **Step 2: Verify pre-turn path**

Restart the app (fresh session), type `/context` before any message.
Expected: breakdown with "(estimated)" suffix, no crash.
