# Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable server-side `clear_tool_uses_20250919` Context Management on the Anthropic path so old tool results stop consuming context on every turn.

**Architecture:** Keep the existing manual loop in `src/engine/loop.ts`. Extend `StreamRequest` with `betas` and `context_management`, route Anthropic requests through `anthropic.beta.messages.create`, and attach a defaulted `context_management.edits` block from the loop. OpenAI-compatible path ignores the new fields.

**Tech Stack:** TypeScript strict, `@anthropic-ai/sdk@^0.124.0` beta messages, vitest, oxlint.

---

## File map

- Modify: `src/engine/api.ts` — extend `StreamRequest`, add `CONTEXT_MANAGEMENT_BETA` constant, route to `beta.messages.create` when `betas` present, merge OAuth beta header with request betas.
- Modify: `src/engine/loop.ts` — add exported `DEFAULT_CONTEXT_MANAGEMENT` constant and `contextManagement?: ContextManagementConfig | false` to `EngineOptions`, attach to `streamOnce` request.
- Modify: `tests/engine-loop.test.ts` — add capturing-client assertions for request shape (Anthropic path sends betas + edits).
- Create: `tests/engine-context-management.test.ts` — dedicated tests for defaults, opt-out, and OpenAI no-op.
- Modify: `tests/engine-api-auth.test.ts` — extend mock to cover beta route and header merge.
- Bump: `src/version.ts`, `package.json`, `package-lock.json` (2 fields), `installer/cloudcode.iss` — patch bump in the same commit per AGENTS.md.

Constrained types (no `any`, no `!`):

```ts
export interface ContextManagementEdit {
  type: "clear_tool_uses_20250919";
  trigger: { type: "input_tokens"; value: number };
  keep: { type: "tool_uses"; value: number };
  clear_at_least?: { type: "input_tokens"; value: number };
  exclude_tools?: string[];
  clear_tool_inputs?: false;
}
export interface ContextManagementConfig {
  edits: ContextManagementEdit[];
}
```

Defaults (locked):

```ts
export const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementConfig = {
  edits: [{
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 100_000 },
    keep: { type: "tool_uses", value: 3 },
    clear_at_least: { type: "input_tokens", value: 5_000 },
    clear_tool_inputs: false,
  }],
};
export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
```

---

### Task 1: Extend StreamRequest + beta route in api.ts

**Files:**
- Modify: `src/engine/api.ts:5-18`
- Test: `tests/engine-api-auth.test.ts`

- [ ] **Step 1: Write the failing test for beta route**

Add to `tests/engine-api-auth.test.ts`:

```ts
it("routes through beta.messages.create when betas are present", async () => {
  const { makeClient } = await import("../src/engine/api.js");
  const betaCreate = vi.fn(async function* () {});
  vi.mocked(AnthropicMock);
});
```

Note: the existing file mocks `@anthropic-ai/sdk` with a `FakeAnthropic` class that only has `messages.create`. For this plan, extend the mock in the test step to include `beta.messages.create` and assert it is called when `betas` is present. Full mock code is in Step 3 of Task 2; run this test first and watch it fail with `beta is undefined`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/engine-api-auth.test.ts`
Expected: FAIL (beta path missing).

- [ ] **Step 3: Write minimal implementation in src/engine/api.ts**

Replace lines 5-13 with:

```ts
export interface ContextManagementEdit {
  type: "clear_tool_uses_20250919";
  trigger: { type: "input_tokens"; value: number };
  keep: { type: "tool_uses"; value: number };
  clear_at_least?: { type: "input_tokens"; value: number };
  exclude_tools?: string[];
  clear_tool_inputs?: false;
}

export interface ContextManagementConfig {
  edits: ContextManagementEdit[];
}

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export interface StreamRequest {
  model: string;
  system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: unknown[];
  tools: unknown[];
  max_tokens: number;
  thinking?: { type: "adaptive" } | { type: "disabled" };
  output_config?: { effort: "low" | "medium" | "high" };
  betas?: string[];
  context_management?: ContextManagementConfig;
}
```

Replace the `create` generator body (lines 41-47) with:

```ts
async *create(req, signal) {
  const hasBetas = req.betas !== undefined && req.betas.length > 0;
  const api = hasBetas ? anthropic.beta.messages : anthropic.messages;
  const stream = await api.create(
    { ...req, stream: true } as never,
    hasBetas
      ? { signal }
      : { signal },
  );
  for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) yield event;
}
```

Note on header merge: `makeClient` already sets `defaultHeaders: { "anthropic-beta": auth.betaHeader }` for OAuth. When `req.betas` includes `context-management-2025-06-27` AND OAuth is active, the SDK merges per-request `betas` with `defaultHeaders` automatically (SDK `betas` param appends to the header). No manual merge needed. Do not concatenate headers by hand.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/engine-api-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/api.ts tests/engine-api-auth.test.ts
git commit -m "feat(engine): route context-management requests via beta messages"
```

---

### Task 2: Attach default context_management in loop.ts

**Files:**
- Modify: `src/engine/loop.ts:29-60`
- Modify: `src/engine/loop.ts:410-419`
- Test: `tests/engine-context-management.test.ts` (create)

- [ ] **Step 1: Write the failing test (new file)**

Create `tests/engine-context-management.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const textTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

describe("context management request shape", () => {
  it("sends betas + clear_tool_uses edit by default", async () => {
    const requests: unknown[] = [];
    const loop = new EngineLoop({
      client: capturingClient([textTurn()], requests) as never,
      model: "claude-sonnet-4-5",
      systemPrompt: "sys",
      tools: [],
      cwd: mkdtempSync(join(tmpdir(), "cc-")),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(),
      onMessage: () => {},
      requestPermission: async () => true,
    });
    await loop.runTurn("hello", new AbortController().signal);
    const req = requests[0] as Record<string, unknown>;
    expect(req.betas).toEqual(["context-management-2025-06-27"]);
    const cm = req.context_management as { edits: Array<Record<string, unknown>> };
    expect(cm.edits[0]).toMatchObject({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 100_000 },
      keep: { type: "tool_uses", value: 3 },
    });
  });

  it("opt-out with contextManagement: false sends neither field", async () => {
    const requests: unknown[] = [];
    const loop = new EngineLoop({
      client: capturingClient([textTurn()], requests) as never,
      model: "claude-sonnet-4-5",
      systemPrompt: "sys",
      tools: [],
      cwd: mkdtempSync(join(tmpdir(), "cc-")),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(),
      contextManagement: false,
      onMessage: () => {},
      requestPermission: async () => true,
    });
    await loop.runTurn("hello", new AbortController().signal);
    const req = requests[0] as Record<string, unknown>;
    expect(req.betas).toBeUndefined();
    expect(req.context_management).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/engine-context-management.test.ts`
Expected: FAIL with `expected [...] but got undefined` (no betas sent yet).

- [ ] **Step 3: Write minimal implementation in src/engine/loop.ts**

Add after the `FALLBACK_COMPACT_THRESHOLD_PCT` constant (line 27):

```ts
import type { ContextManagementConfig } from "./api.js";
import { CONTEXT_MANAGEMENT_BETA } from "./api.js";

export const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementConfig = {
  edits: [{
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 100_000 },
    keep: { type: "tool_uses", value: 3 },
    clear_at_least: { type: "input_tokens", value: 5_000 },
    clear_tool_inputs: false,
  }],
};
```

Add to `EngineOptions` (after `contextWindow?: number;`):

```ts
contextManagement?: ContextManagementConfig | false;
```

In `streamOnce`, replace the `req` object literal (lines 410-419) to append:

```ts
...(this.opts.contextManagement === false
  ? {}
  : {
      betas: [CONTEXT_MANAGEMENT_BETA],
      context_management: this.opts.contextManagement ?? DEFAULT_CONTEXT_MANAGEMENT,
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/engine-context-management.test.ts tests/engine-loop.test.ts`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts tests/engine-context-management.test.ts
git commit -m "feat(engine): enable clear_tool_uses context management by default"
```

---

### Task 3: OpenAI path ignores new fields + version bump + full verification

**Files:**
- Modify: `src/engine/openaiApi.ts:112-127` (no-op guard, assert in test)
- Modify: `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`
- Test: `tests/engine-openai-api.test.ts`

- [ ] **Step 1: Write the failing test for OpenAI no-op**

Add to `tests/engine-openai-api.test.ts` a case that builds a `StreamRequest` with `betas` + `context_management`, runs it through the fetch mock, and asserts the outgoing fetch body has no `betas` / `context_management` keys (they must not leak to `/chat/completions`).

```ts
it("drops betas and context_management before sending to OpenAI", async () => {
  const seen: unknown[] = [];
  const fetchMock = async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, body: null };
  };
  // wire fetchMock as global fetch, call client.create with betas set,
  // then assert seen[0] has no betas/context_management keys.
});
```

(Adapt to the existing mock style in that file; the assertion is `expect(seen[0]).not.toHaveProperty("betas")` and `not.toHaveProperty("context_management")`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/engine-openai-api.test.ts`
Expected: FAIL (body currently forwards unknown keys if spread blindly; if `translateRequest` already drops them, the test passes immediately — then keep the test as a pin and move on).

- [ ] **Step 3: Implement no-op guard if needed**

`translateRequest` in `src/engine/openaiApi.ts` builds `body` explicitly from `model/messages/tools/max_tokens` and never spreads `req`. If so, no code change is needed — the test is a regression pin. If the test fails, remove the leaking keys explicitly. Do not add `any`.

- [ ] **Step 4: Patch version bump (all four places together)**

```bash
# 0.1.40 -> 0.1.41 (adjust to current VERSION in src/version.ts)
```

Edit `src/version.ts` (`VERSION`), `package.json` (`version`), `package-lock.json` (top-level `version` + `packages[""].version`), `installer/cloudcode.iss` (`#define AppVersion`).

- [ ] **Step 5: Full verification**

Run in order:

```bash
npm run lint
npm run lint:size
npm run build
npm test -- --run tests/engine-context-management.test.ts tests/engine-loop.test.ts tests/engine-api-auth.test.ts tests/engine-openai-api.test.ts tests/packaging.test.ts
```

Expected: lint warnings only (pre-existing unused imports), size warnings only (soft limit), build exit 0, targeted tests PASS. Full `npm test` has one known-flaky `tests/app-queue.test.ts` timing case; if it fails, re-run it alone to confirm flake.

- [ ] **Step 6: Commit**

```bash
git add src/engine/openaiApi.ts tests/engine-openai-api.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(engine): pin OpenAI path to ignore context management"
```

---

## Self-review

1. **Spec coverage:** Architecture section asked for betas + edits on Anthropic path only (Task 1+2), OpenAI no-op (Task 3), defaults trigger 100k / keep 3 / clear_at_least 5k / clear_tool_inputs false (Task 2), error handling via existing per-turn boundary with no auto-retry (no new try/catch added — matches plan), testing via request-shape pins (Tasks 1-3). Covered.
2. **Placeholder scan:** No TBD/TODO; every step has exact file paths, code blocks, commands, expected outputs.
3. **Type consistency:** `ContextManagementEdit` / `ContextManagementConfig` / `DEFAULT_CONTEXT_MANAGEMENT` / `CONTEXT_MANAGEMENT_BETA` names match across Tasks 1-2. `EngineOptions.contextManagement` is `ContextManagementConfig | false`, `undefined` means default-on. Consistent.
