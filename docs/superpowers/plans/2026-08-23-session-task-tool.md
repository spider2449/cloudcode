# Session Task Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `Task` tool that dispatches a synchronous, read-only exploration subagent running a nested `EngineLoop` in its own context window.

**Architecture:** `createTaskTool(deps)` builds a fresh `EngineLoop` per invocation with exactly eight read-only tools (Read, Glob, Grep + five LSP), a compact explorer system prompt, and the parent's permission store/mode/callback so overlays queue normally. `builtinTools()` registers the tool only when the caller supplies deps. Recursion is structurally impossible because the subagent toolset excludes `Task`.

**Tech Stack:** TypeScript (strict), existing `EngineLoop`, vitest with the scripted fake-client pattern from `tests/engine-loop.test.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-23-session-task-tool-design.md`.
- All code/comments in English only.
- `tsconfig.json` stays `"strict": true`; no `any`, no non-null `!` assertions (cast through `unknown` in tests where needed).
- No file in `src/` may exceed ~600 lines (`npm run lint:size`; `nativeApp.ts` is already over the soft limit â€” do not add code there).
- Subagent turn cap: **30** (exported as `SUBAGENT_MAX_TURNS`).
- Error handling only at existing boundaries: the nested `runTurn` never rejects â€” it reports failures as `error_during_execution` messages; the task tool converts those into `{ isError: true }` results.
- Tests land in the same commit as the code they cover.

---

### Task 1: `EngineLoop` knobs â€” `maxTurns` option and state getters

**Files:**
- Modify: `src/engine/loop.ts` (`EngineOptions`, `runTurn`, class body)
- Test: `tests/engine-loop.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 3â€“4):
  - `EngineOptions.maxTurns?: number` â€” caps provider turns; defaults to the existing `MAX_LOOP_TURNS` (100).
  - `loop.getModel(): string`
  - `loop.getPermissionMode(): PermissionMode`
  - `loop.getEffort(): EffortLevel`

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe("EngineLoop", ...)` block of `tests/engine-loop.test.ts` (reuse the file's existing `fakeClient`, `toolUseTurn`, `textTurn`, `mkdtempSync`/`tmpdir`/`join` imports):

```ts
  it("honors a custom maxTurns cap and reports the limit", async () => {
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client: fakeClient(Array(6).fill(0).map(() => toolUseTurn())),
      model: "test-model",
      systemPrompt: "sys",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-mt-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true,
      maxTurns: 3
    });
    await loop.runTurn("go", new AbortController().signal);
    const texts = received
      .filter(m => (m as { type?: string }).type === "assistant")
      .flatMap(m => (m as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message.content)
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("\n");
    expect(texts).toContain("[Stopped after 3 tool-use turns without a final answer]");
  });

  it("exposes model, permission mode, and effort through getters", () => {
    const loop = new EngineLoop({
      client: fakeClient([]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [],
      cwd: process.cwd(),
      permissionMode: "acceptEdits",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-g-"))),
      onMessage: () => {},
      requestPermission: async () => true,
      effort: "high"
    });
    loop.setPermissionMode("default");
    loop.setEffort("low");
    loop.setModel("other-model");
    expect(loop.getModel()).toBe("other-model");
    expect(loop.getPermissionMode()).toBe("default");
    expect(loop.getEffort()).toBe("low");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: FAIL â€” `maxTurns` is not an accepted option (excess property / the cap stays at 100 so the "[Stopped after 3..." notice never appears), and `getModel` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/loop.ts`:

(a) Add to `EngineOptions` (after `networkPolicy?: NetworkPolicy;`):

```ts
  /** Provider-turn ceiling for this loop. Defaults to MAX_LOOP_TURNS. */
  maxTurns?: number;
```

(b) At the top of `runTurn` (next to the other `let` declarations, e.g. after `let reached: RunLimitKind | undefined;`):

```ts
    const maxTurns = this.opts.maxTurns ?? MAX_LOOP_TURNS;
```

(c) Replace every other use of `MAX_LOOP_TURNS` inside `runTurn` with `maxTurns` â€” three places: the `for` loop bound (`i < maxTurns`), the cut-off notice text (`` `\n[Stopped after ${maxTurns} tool-use turns without a final answer]` ``), and `markLimit("maxTurns", maxTurns)`. Leave the `const MAX_LOOP_TURNS = 100;` declaration itself untouched (it becomes the default).

(d) Add these getters to the class body (after `setEffort`):

```ts
  getModel(): string {
    return this.model;
  }

  getPermissionMode(): PermissionMode {
    return this.mode;
  }

  getEffort(): EffortLevel {
    return this.effort;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: PASS (all tests, including the pre-existing ones â€” they exercise the default cap path).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts tests/engine-loop.test.ts
git commit -m "feat(engine): maxTurns option and state getters on EngineLoop"
```

---

### Task 2: Explorer system prompt

**Files:**
- Modify: `src/engine/systemPrompt.ts`
- Test: `tests/engine-system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildSubagentSystemPrompt(cwd: string): string` â€” used by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-system-prompt.test.ts` (merge with the file's existing vitest imports):

```ts
describe("buildSubagentSystemPrompt", () => {
  it("describes a read-only explorer scoped to the working directory", () => {
    const prompt = buildSubagentSystemPrompt("/repo");
    expect(prompt).toContain("code-exploration subagent");
    expect(prompt).toContain("/repo");
    expect(prompt.toLowerCase()).toContain("do not attempt to change");
  });
});
```

Extend the existing import from `../src/engine/systemPrompt.js` to include `buildSubagentSystemPrompt`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-system-prompt.test.ts`
Expected: FAIL â€” `buildSubagentSystemPrompt` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/engine/systemPrompt.ts`:

```ts
const SUBAGENT_BASE = `You are a code-exploration subagent inside cloudcode.
Investigate the request using only your read and search tools (Read, Glob,
Grep, and LSP lookups). Do not attempt to change anything. Report findings
concisely with precise file paths and line numbers. Working directory: `;

export function buildSubagentSystemPrompt(cwd: string): string {
  return SUBAGENT_BASE + cwd;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-system-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/systemPrompt.ts tests/engine-system-prompt.test.ts
git commit -m "feat(engine): explorer system prompt for subagents"
```

---

### Task 3: `runSubagent` + `createTaskTool`

**Files:**
- Create: `src/engine/tools/task.ts`
- Test: `tests/engine-task-tool.test.ts`

**Interfaces:**
- Consumes: `EngineLoop` with `maxTurns`/getters (Task 1), `buildSubagentSystemPrompt` (Task 2), existing tools `readTool`, `globTool`, `grepTool`, LSP tools, `MessagesClient`, `PermissionStore`, `NetworkPolicy`, `PermissionMode` (type-only import from `../../agent/session.js`, same precedent as `loop.ts`), `EffortLevel` from `../effort.js`, `LspManager` from `../lsp/manager.js`.
- Produces:
  - `SUBAGENT_MAX_TURNS = 30`
  - `interface TaskToolDeps` (full definition below)
  - `subagentTools(): ToolDef[]` â€” exactly the eight read-only tools
  - `runSubagent(deps: SubagentDeps, cwd: string, prompt: string, signal: AbortSignal): Promise<ToolOutput>`
  - `createTaskTool(deps: TaskToolDeps): ToolDef` â€” tool named `"Task"`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-task-tool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskTool, runSubagent, subagentTools, SUBAGENT_MAX_TURNS } from "../src/engine/tools/task.js";
import { PermissionStore } from "../src/agent/permissionStore.js";

// Scripted fake client, same shape as tests/engine-loop.test.ts.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    async *create(_req: unknown) {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

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

const textTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

// One Grep call against a path that does not exist: cheap, deterministic.
const grepTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "Grep", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":"zzz-nomatch","path":"/nonexistent-cc-dir"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    client: () => fakeClient([]),
    model: () => "test-model",
    effort: () => "off" as const,
    contextWindow: () => 200000,
    permissionMode: () => "bypassPermissions" as const,
    // A real store backed by an empty temp project; decidePermission consults
    // it whenever a tool names a path, so a bare object would crash.
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-task-"))),
    lsp: undefined,
    networkPolicy: undefined,
    requestPermission: async () => true,
    ...overrides
  };
}

describe("subagentTools", () => {
  it("contains exactly the eight read-only tools and never Task", () => {
    expect(subagentTools().map(t => t.name).sort())
      .toEqual(["Definition", "Diagnostics", "Glob", "Grep", "Hover", "Read", "References", "Symbols"]);
  });
});

describe("runSubagent", () => {
  it("returns the subagent's final assistant text", async () => {
    const deps = makeDeps({ client: () => fakeClient([grepTurn(), textTurn("found it in src/auth.ts:42")]) });
    const out = await runSubagent(deps as never, "/tmp", "find the token logic", new AbortController().signal);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("found it in src/auth.ts:42");
  });

  it("exposes only the restricted toolset to the provider", async () => {
    const requests: unknown[] = [];
    const deps = makeDeps({
      client: () => capturingClient([grepTurn(), textTurn("done")], requests)
    });
    await runSubagent(deps as never, "/tmp", "look around", new AbortController().signal);
    const first = requests[0] as { tools: Array<{ name: string }> };
    expect(first.tools.map(t => t.name).sort())
      .toEqual(["Definition", "Diagnostics", "Glob", "Grep", "Hover", "Read", "References", "Symbols"]);
  });

  it("prefixes a cut-off note when the turn cap is hit", async () => {
    const deps = makeDeps({ client: () => fakeClient(Array(SUBAGENT_MAX_TURNS + 5).fill(0).map(() => grepTurn())) });
    const out = await runSubagent(deps as never, "/tmp", "endless exploration", new AbortController().signal);
    expect(out.content).toContain(`[Exploration stopped after ${SUBAGENT_MAX_TURNS} turns without a final answer]`);
  });

  it("converts a nested provider failure into an error result", async () => {
    const failing = {
      async *create() { throw new Error("boom"); }
    };
    const deps = makeDeps({ client: () => failing });
    const out = await runSubagent(deps as never, "/tmp", "explode", new AbortController().signal);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("boom");
  });

  it("propagates permission rules: a denied inner tool call does not fail the subagent", async () => {
    const deps = makeDeps({
      permissionMode: () => "default" as const,
      requestPermission: async () => false,
      client: () => fakeClient([grepTurn(), textTurn("done anyway")])
    });
    const out = await runSubagent(deps as never, "/tmp", "try to search", new AbortController().signal);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("done anyway");
  });

  it("reports an interrupt as interrupted, not a crash", async () => {
    const controller = new AbortController();
    let call = 0;
    const client = {
      async *create() {
        call += 1;
        // Aborting before a tool-use turn makes the loop break at its
        // post-stream abort check (line "if (signal.aborted)" after
        // stop_reason === "tool_use"), so no final answer is reached.
        if (call === 2) controller.abort();
        const events = grepTurn();
        for (const e of events) yield e as never;
      }
    };
    const deps = makeDeps({ client: () => client });
    const out = await runSubagent(deps as never, "/tmp", "interrupt me", controller.signal);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Interrupted");
  });
});

describe("createTaskTool", () => {
  it("validates its input before spawning anything", async () => {
    const tool = createTaskTool(makeDeps() as never);
    const out = await tool.execute({}, { cwd: "/tmp" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("prompt");
  });

  it("runs under the Task name and forwards the abort signal", async () => {
    const requests: unknown[] = [];
    const tool = createTaskTool(makeDeps({
      client: () => capturingClient([textTurn("ok")], requests)
    }) as never);
    const controller = new AbortController();
    const out = await tool.execute(
      { description: "check things", prompt: "inspect the layout" },
      { cwd: "/tmp", signal: controller.signal }
    );
    expect(tool.name).toBe("Task");
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-task-tool.test.ts`
Expected: FAIL â€” module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/engine/tools/task.ts`:

```ts
import { EngineLoop } from "../loop.js";
import { buildSubagentSystemPrompt } from "../systemPrompt.js";
import type { EffortLevel } from "../effort.js";
import type { LspManager } from "../lsp/manager.js";
import type { EngineMessage } from "../messages.js";
import type { MessagesClient } from "../api.js";
import type { NetworkPolicy } from "../../agent/networkPolicy.js";
import type { PermissionStore } from "../../agent/permissionStore.js";
import type { PermissionMode } from "../../agent/session.js";
import type { ToolDef, ToolOutput } from "./types.js";
import { readTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool } from "./lsp.js";

/** Subagents explore; they get far fewer turns than the main loop's 100. */
export const SUBAGENT_MAX_TURNS = 30;

export interface TaskToolDeps {
  client(): MessagesClient;
  model(): string;
  effort(): EffortLevel;
  contextWindow?(): number;
  permissionMode(): PermissionMode;
  store: PermissionStore;
  lsp?: LspManager;
  networkPolicy?: NetworkPolicy;
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

type SubagentDeps = Pick<
  TaskToolDeps,
  "client" | "model" | "effort" | "contextWindow" | "permissionMode" | "store" | "lsp" | "networkPolicy" | "requestPermission"
>;

export function subagentTools(): ToolDef[] {
  return [
    readTool, globTool, grepTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool
  ];
}

// Scans backwards for the newest assistant history entry and joins its text
// blocks â€” the subagent's "final answer".
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const blocks = m.content as Array<{ type: string; text?: string }>;
    return blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  }
  return "";
}

export async function runSubagent(
  deps: SubagentDeps,
  cwd: string,
  prompt: string,
  signal: AbortSignal
): Promise<ToolOutput> {
  const received: EngineMessage[] = [];
  const loop = new EngineLoop({
    client: deps.client(),
    model: deps.model(),
    systemPrompt: buildSubagentSystemPrompt(cwd),
    tools: subagentTools(),
    cwd,
    permissionMode: deps.permissionMode(),
    store: deps.store,
    lsp: deps.lsp,
    networkPolicy: deps.networkPolicy,
    effort: deps.effort(),
    contextWindow: deps.contextWindow?.(),
    maxTurns: SUBAGENT_MAX_TURNS,
    onMessage: m => received.push(m),
    requestPermission: deps.requestPermission
  });
  await loop.runTurn(prompt, signal);

  const last = received[received.length - 1];
  if (last?.type === "result" && last.subtype === "error_during_execution") {
    return { content: last.result, isError: true };
  }
  const hitCap = received.some(m => m.type === "limit" && m.limit === "maxTurns");
  if (hitCap) {
    const partial = lastAssistantText(loop.messages);
    const note = `[Exploration stopped after ${SUBAGENT_MAX_TURNS} turns without a final answer]`;
    return { content: partial !== "" ? `${note}\n\n${partial}` : note };
  }
  const text = lastAssistantText(loop.messages);
  if (text !== "") return { content: text };
  return {
    content: signal.aborted ? "Interrupted by user" : "(subagent produced no output)",
    isError: true
  };
}

export function createTaskTool(deps: TaskToolDeps): ToolDef {
  return {
    name: "Task",
    description:
      "Dispatch a read-only exploration subagent with its own context window. " +
      "It can Read/Glob/Grep and use LSP lookups, then reports its findings back.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short 3-5 word summary of the investigation (shown to the user)" },
        prompt: { type: "string", description: "Full instruction for the subagent: what to find and what to report" }
      },
      required: ["description", "prompt"]
    },
    execute(input, ctx) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (prompt === "") {
        return Promise.resolve({ content: "Task requires a prompt describing what to investigate.", isError: true });
      }
      return runSubagent(deps, ctx.cwd, prompt, ctx.signal ?? new AbortController().signal);
    }
  };
}
```

If the LSP tool exports differ from `definitionTool/referencesTool/hoverTool/symbolsTool/diagnosticsTool`, match whatever `src/engine/registry.ts` already imports (it imports exactly those five names from `./tools/lsp.js`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-task-tool.test.ts`
Expected: PASS. If the LSP tool names differ from the assertion's sorted list, fix the *assertion* to match the actual five LSP names exported by `src/engine/tools/lsp.ts` (the count of eight and absence of "Task" must hold).

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/task.ts tests/engine-task-tool.test.ts
git commit -m "feat(tools): Task tool running a read-only exploration subagent"
```

---

### Task 4: Registration and session wiring

**Files:**
- Modify: `src/engine/registry.ts`
- Modify: `src/agent/session.ts` (the `builtinTools({...})` call, ~line 105)
- Test: `tests/engine-sessions.test.ts` (or wherever builtin-tools registration is asserted)

**Interfaces:**
- Consumes: `createTaskTool`, `TaskToolDeps` from Task 3; `EngineLoop` getters from Task 1.
- Produces: `builtinTools(options: { allowArbitraryChildNetwork?: boolean; task?: TaskToolDeps })` â€” `Task` present iff `options.task` is set. Session supplies deps wired to live state.

- [ ] **Step 1: Write the failing test**

Find the existing test that asserts on `builtinTools()` output (grep `tests/` for `builtinTools`). If one asserts the exact tool-name list, add `"Task"` expectations behind the new option. Add this test to that file (adjust the import path if the helper lives elsewhere):

```ts
import { builtinTools } from "../src/engine/registry.js";

describe("builtinTools task option", () => {
  it("omits Task when no deps are provided", () => {
    expect(builtinTools().map(t => t.name)).not.toContain("Task");
  });

  it("registers Task when deps are provided", () => {
    const deps = {
      client: () => { throw new Error("not called"); },
      model: () => "m",
      effort: () => "off" as const,
      permissionMode: () => "default" as const,
      store: {},
      requestPermission: async () => true
    };
    const names = builtinTools({ task: deps as never }).map(t => t.name);
    expect(names).toContain("Task");
  });
});
```

If `tests/engine-sessions.test.ts` (or the file you found) already imports `builtinTools`, merge into its structure instead of duplicating imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <that test file>`
Expected: FAIL â€” `task` is not a known option (the "registers Task" case fails).

- [ ] **Step 3: Implement**

(a) In `src/engine/registry.ts`:

```ts
import { webfetchTool } from "./tools/webfetch.js";
import { createTaskTool, type TaskToolDeps } from "./tools/task.js";
```

Change the signature and body:

```ts
export function builtinTools(options: {
  allowArbitraryChildNetwork?: boolean;
  task?: TaskToolDeps;
} = {}): ToolDef[] {
  const tools = [
    readTool, writeTool, editTool, bashTool, globTool, grepTool, webfetchTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool,
    ...(options.task ? [createTaskTool(options.task)] : [])
  ];
  return options.allowArbitraryChildNetwork === false
    ? tools.filter(tool => tool.capabilities?.arbitraryChildNetwork !== true)
    : tools;
}
```

(b) In `src/agent/session.ts`, extend the existing `builtinTools` call (currently `builtinTools({ allowArbitraryChildNetwork: bash.available })`) to:

```ts
    const availableTools = builtinTools({
      allowArbitraryChildNetwork: bash.available,
      task: {
        client: () => makeClient(this.opts.provider),
        model: () => this.loop?.getModel() ?? model,
        effort: () => this.loop?.getEffort() ?? this.opts.effort ?? "off",
        contextWindow: () => this.opts.provider.model_context_window,
        permissionMode: () => this.loop?.getPermissionMode() ?? this.opts.permissionMode,
        store,
        lsp: this.lsp,
        networkPolicy,
        requestPermission: (toolName, input) =>
          new Promise(resolve => this.opts.onPermissionRequest({ toolName, input, resolve }))
      }
    });
```

Notes:
- `makeClient`, `store`, `networkPolicy`, `bash`, and the local `model` binding already exist in scope at that point (see the surrounding code â€” `makeClient` is imported at the top of the file; reuse that import rather than adding a new one).
- The getters keep the subagent live against `/model`, `/permissions`, and `/effort` switches made after session start.

(c) Sweep for broken assertions: run the full suite and update any test that enumerates the builtin tool names to include `"Task"` **only** in contexts where the session provides deps (interactive session tests). Print-mode tests must continue to see NO `Task` (printMode does not pass `task` deps).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-sessions.test.ts tests/session.test.ts tests/printMode.test.ts tests/session-integration.test.ts`
Expected: PASS. If a session-level test asserts the exact exposed tool-name list, add `"Task"` to its expectation (the interactive session now provides task deps).

- [ ] **Step 5: Commit**

```bash
git add src/engine/registry.ts src/agent/session.ts tests/
git commit -m "feat(agent): register Task tool in interactive sessions"
```

---

### Task 5: Full verification

**Files:** none created; verification only.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: exits 0, no type errors.

- [ ] **Step 2: Lint and size check**

Run: `npm run lint ; npm run lint:size`
Expected: no new errors/warnings beyond the two pre-existing `autoInject.test.ts` unused-import warnings and the pre-existing `nativeApp.ts` soft-limit warning.

- [ ] **Step 3: Whole suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Run: `npm run dev` in any project and prompt: "Use the Task tool to find where the app renders the status bar, then summarize." Expect: a permission prompt for the Task call; after allowing, the subagent runs silently (no transcript spam), and its findings appear as the tool result.

- [ ] **Step 5: Commit stragglers**

```bash
git status
```

Expected: clean tree.

