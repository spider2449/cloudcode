# llama.cpp Context Window Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect the effective context window from a llama.cpp server (`GET /props`) for OpenAI-compatible providers and use it whenever `model_context_window` is not manually configured.

**Architecture:** A new `agent/`-layer module (`src/agent/contextProbe.ts`) probes `{baseUrl}/props` with a 2s timeout, parses `default_generation_settings.n_ctx` then top-level `n_ctx`, and returns `undefined` on any failure. An exported wrapper `applyContextWindow` enforces precedence (manual value wins, Anthropic-kind skipped) and memoizes by base URL. Two call sites patch the in-memory provider object before session creation: `src/cli.tsx` (initial provider; covers interactive, print, and task paths since they share it) and `App.restartSession` in `src/ui/nativeApp.ts` (mid-session `/provider` switches).

**Tech Stack:** TypeScript (strict), Node `fetch` + `AbortSignal.timeout`, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-23-llamacpp-context-probe-design.md`.
- All code/comments in English (CLAUDE.md rule).
- No `any`; no non-null `!` assertions; `tsconfig.json` stays `"strict": true` (AGENTS.md).
- No comments in new code unless mirroring an existing explanatory comment pattern (models.ts has short "why" comments — mirror that style only where genuinely non-obvious).
- Never throw out of the probe: every failure path returns `undefined` silently.
- No write-back to `providers.json`; detection patches the in-memory object only.
- Only probe providers with `kind === "openai"`; a manually set `model_context_window` always wins.
- Memoization key: base URL with trailing slash(es) trimmed; failures are cached too (one attempt per server per process).
- Commands: `npx vitest run <file>` (single test file), `npm run lint`, `npm run lint:size`, `npm run build`, `npm test`.

---

### Task 1: `src/agent/contextProbe.ts` with unit tests

**Files:**
- Create: `src/agent/contextProbe.ts`
- Test: `tests/contextProbe.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` from `src/agent/providers.ts` (fields used: `kind?: "anthropic" | "openai"`, `baseUrl?: string`, `model_context_window?: number`).
- Produces (Task 2 relies on these exact signatures):
  - `detectContextWindow(provider: ProviderConfig, fetchFn?: typeof fetch): Promise<number | undefined>`
  - `applyContextWindow(provider: ProviderConfig | undefined, fetchFn?: typeof fetch): Promise<void>`

This module mirrors the established pattern of `src/agent/models.ts`: injectable `fetchFn` parameter (defaults to global `fetch`), trailing-slash-stripped baseUrl, silent best-effort error handling. Read `src/agent/models.ts` first to match style.

- [ ] **Step 1: Write the failing tests**

Create `tests/contextProbe.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { applyContextWindow, detectContextWindow } from "../src/agent/contextProbe.js";

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe("detectContextWindow", () => {
  it("parses default_generation_settings.n_ctx (current llama.cpp builds)", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 }, total_slots: 4 });
    expect(await detectContextWindow({ baseUrl: "http://localhost:8080" }, fetchFn as never)).toBe(262144);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/props");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 4096 } });
    await detectContextWindow({ baseUrl: "http://localhost:8080/" }, fetchFn as never);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/props");
  });

  it("falls back to top-level n_ctx (older builds)", async () => {
    const fetchFn = ok({ n_ctx: 32768 });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBe(32768);
  });

  it("prefers nested over top-level when both exist", async () => {
    const fetchFn = ok({ n_ctx: 1, default_generation_settings: { n_ctx: 8192 } });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBe(8192);
  });

  it("rejects zero, negative, fractional, and non-number values", async () => {
    for (const bad of [0, -1, 1.5, "32768", null]) {
      const fetchFn = ok({ default_generation_settings: { n_ctx: bad } });
      expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
    }
  });

  it("resolves undefined without a request when there is no baseUrl", async () => {
    const fetchFn = ok({});
    expect(await detectContextWindow({}, fetchFn as never)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resolves undefined on non-OK status", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });

  it("resolves undefined on malformed JSON body", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("bad json"); } });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });

  it("resolves undefined on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });
});

describe("applyContextWindow", () => {
  it("assigns the detected value to the in-memory provider", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 } });
    const provider = { kind: "openai" as const, baseUrl: "http://localhost:8080" };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBe(262144);
  });

  it("keeps a manually configured model_context_window without probing", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 } });
    const provider = { kind: "openai" as const, baseUrl: "http://x", model_context_window: 4096 };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBe(4096);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips anthropic-kind providers entirely", async () => {
    const fetchFn = ok({ n_ctx: 1000 });
    const provider = { kind: "anthropic" as const };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("tolerates an undefined provider", async () => {
    const fetchFn = ok({});
    await expect(applyContextWindow(undefined, fetchFn as never)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves model_context_window unset when detection fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const provider = { kind: "openai" as const, baseUrl: "http://x" };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBeUndefined();
  });

  it("memoizes by trimmed baseUrl within the process, including failures", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 8192 } });
    const hit = { kind: "openai" as const, baseUrl: "http://m" };
    const again = { kind: "openai" as const, baseUrl: "http://m/" };
    await applyContextWindow(hit, fetchFn as never);
    await applyContextWindow(again, fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(hit.model_context_window).toBe(8192);
    expect(again.model_context_window).toBe(8192);

    const failedFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const miss = { kind: "openai" as const, baseUrl: "http://m2" };
    await applyContextWindow(miss, failedFetch as never);
    await applyContextWindow(miss, failedFetch as never);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });
});
```

Note on memoization tests: the cache lives at module level, so these tests depend on execution order within the file (vitest runs tests in declaration order by default). If flakiness appears under parallel workers, keep the two memoization assertions inside the single `it` block exactly as written so they share order deterministically — do not split them across files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contextProbe.test.ts`
Expected: FAIL — cannot resolve import `../src/agent/contextProbe.js`.

- [ ] **Step 3: Write the implementation**

Create `src/agent/contextProbe.ts`:

```typescript
import type { ProviderConfig } from "./providers.js";

// One probe result per server per process. Failures are cached too so an
// unreachable server never adds latency twice.
const cache = new Map<string, number | undefined>();

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function detectContextWindow(
  provider: ProviderConfig,
  fetchFn: typeof fetch = fetch
): Promise<number | undefined> {
  if (!provider.baseUrl) return undefined;
  try {
    // /props reports the server's allocated context (-c), unlike
    // /v1/models meta which reflects model hparams. Newer builds nest
    // n_ctx under default_generation_settings; older ones expose it top level.
    const res = await fetchFn(`${trimBase(provider.baseUrl)}/props`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = await res.json();
    const nested = (body as { default_generation_settings?: { n_ctx?: unknown } }).default_generation_settings?.n_ctx;
    const top = (body as { n_ctx?: unknown }).n_ctx;
    return asPositiveInt(nested) ?? asPositiveInt(top);
  } catch {
    // background probe: context detection is best-effort
    return undefined;
  }
}

export async function applyContextWindow(
  provider: ProviderConfig | undefined,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (!provider || provider.kind !== "openai" || provider.model_context_window !== undefined) return;
  const key = trimBase(provider.baseUrl ?? "");
  const cached = cache.get(key);
  if (cached !== undefined) {
    provider.model_context_window = cached;
    return;
  }
  if (cache.has(key)) return;
  const detected = await detectContextWindow(provider, fetchFn);
  cache.set(key, detected);
  if (detected !== undefined) provider.model_context_window = detected;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contextProbe.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors for `contextProbe.ts` / `contextProbe.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/contextProbe.ts tests/contextProbe.test.ts
git commit -m "feat(agent): probe llama.cpp /props for effective context window"
```

---

### Task 2: Wire the probe into startup and provider switching

**Files:**
- Modify: `src/cli.tsx` (~line 165, right after provider resolution)
- Modify: `src/ui/nativeApp.ts:272-279` (`restartSession`)
- Test: `tests/app.test.ts` (add one case)

**Interfaces:**
- Consumes: `applyContextWindow(provider: ProviderConfig | undefined, fetchFn?): Promise<void>` from Task 1 (callers omit `fetchFn`).
- Produces: no new exports. Behavior contract: after startup or a `/provider` switch, an OpenAI-kind provider without a manual `model_context_window` carries the detected value, which flows through `AgentSession` → `EngineLoop` → `UsageTracker` unchanged.

- [ ] **Step 1: Add the failing App test**

In `tests/app.test.ts`, extend the module mocks near the top (after the existing `vi.mock("../src/agent/models.js", ...)` block):

```typescript
vi.mock("../src/agent/contextProbe.js", () => ({
  applyContextWindow: vi.fn().mockResolvedValue(undefined)
}));
```

And add to the existing imports from mocked modules (same section as `import { saveSetting } ...`):

```typescript
import { applyContextWindow } from "../src/agent/contextProbe.js";
```

Add this test inside the existing `describe("App", ...)` block (model it on the `/new` test around line 126; `wait` and `textTurn`/`fakeClient` helpers already exist in the file):

```typescript
it("re-probes the context window when switching providers", async () => {
  vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("ok")]) as never);
  vi.mocked(applyContextWindow).mockClear();
  const terminal = new FakeTerminal({ rows: 24, columns: 80 });
  const app = new App({
    cwd: "/repo",
    providers: {
      anthropic: {},
      llama: { kind: "openai", baseUrl: "http://localhost:8080" }
    },
    initialProvider: "anthropic",
    sessionIndex: new SessionIndex()
  }, terminal);
  const running = app.run();
  await wait(5);
  expect(applyContextWindow).toHaveBeenCalledTimes(1);
  app.submitForTest("/provider llama");
  await wait(10);
  expect(applyContextWindow).toHaveBeenCalledTimes(2);
  expect(vi.mocked(applyContextWindow).mock.calls[1][0]).toMatchObject({ baseUrl: "http://localhost:8080" });
  app.submitForTest("/exit");
  await running;
});
```

Note: `expect(applyContextWindow).toHaveBeenCalledTimes(1)` after `run()` asserts the initial-session path also probes (via `run()` awaiting `applyContextWindow` before `createSession` — see Step 3). Adjust count expectations together with the implementation if the initial call site lands in `cli.tsx` instead (see Step 3 note); in that case drop the `toHaveBeenCalledTimes(1)` assertion and assert only the post-switch state (`calls[0]` instead of `calls[1]`). Whichever variant you land on, both call sites must be exercised by this test or by inspection of `src/cli.tsx` (which has no dedicated harness).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL — either the mock-module import fails (module doesn't re-export `applyContextWindow` yet it does, but `nativeApp.ts` never calls it) with assertion mismatch: `applyContextWindow` never called.

- [ ] **Step 3: Wire the call sites**

In `src/ui/nativeApp.ts`:

Add import alongside the other agent-layer imports (near the `fetchModels` import):

```typescript
import { applyContextWindow } from "../agent/contextProbe.js";
```

Change `restartSession` (line 272) to probe before rebuilding the session:

```typescript
private async restartSession(name: string, resume?: string, modeOverride?: PermissionMode): Promise<void> {
  await this.session?.dispose();
  await applyContextWindow(this.props.providers[name]);
  this.firstMessage = undefined;
  this.usage.resetForNewSession();
  this.session = this.createSession(name, resume, modeOverride);
  this.model = this.presentation.modelFor(name);
  this.servedModel = undefined;
}
```

In `App.run()` (line 576), probe the initial provider once trust is resolved, just before the first `createSession`:

```typescript
this.allowProjectConfig = typeof trust === "boolean" ? trust : await trust;
await applyContextWindow(this.props.providers[this.props.initialProvider]);
this.session = this.createSession(this.props.initialProvider, this.props.resume);
```

Putting the initial probe here (rather than in `cli.tsx`) covers interactive, print, and task-launch paths uniformly — `runPrint` and the task executor construct sessions through their own paths, so verify those two files: open `src/commands/printMode.ts` and the task launch path (`src/cli.tsx:74-135` region plus whatever constructs `AgentSession` for tasks, see `src/commands/cli/maintenanceExecutor.ts:12-28`). Wherever such a path constructs an `AgentSession` from `providers[name]` outside `nativeApp.ts`, insert the same single line before construction:

```typescript
await applyContextWindow(providers[providerName]);
```

If and only if such an extra call site exists, add it and note the file(s) in the commit body. Do not add duplicate probes on paths that route through `App.run()` or `restartSession` — memoization makes duplicates harmless but pointless.

- [ ] **Step 4: Run the App test to verify it passes**

Run: `npx vitest run tests/app.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Run the full suite, lint, size check, and build**

Run: `npm test`
Expected: PASS — especially `tests/app-queue.test.ts`, `tests/session.test.ts`, `tests/session-integration.test.ts`, `tests/printMode.test.ts` (any that construct `App`/`AgentSession` and now transitively import `contextProbe.js`; unmocked, the real `applyContextWindow` runs but exits early on anthropic-kind providers, so no network occurs).

Run: `npm run lint; npm run lint:size; npm run build`
Expected: all clean; no file crosses the size ceiling (`nativeApp.ts` gains ~2 lines and stays under 600).

- [ ] **Step 6: Commit**

```bash
git add src/cli.tsx src/ui/nativeApp.ts src/commands/printMode.ts tests/app.test.ts
git commit -m "feat: auto-detect llama.cpp context window at startup and provider switch"
```

(Path list: include only files actually modified.)

---

### Task 3: Live smoke test against localhost:8080

**Files:** none created; verification only. Requires the local llama.cpp server from design exploration to be running.

**Interfaces:**
- Consumes: built CLI (`npm run dev`).

- [ ] **Step 1: Confirm the server still answers**

```powershell
(Invoke-RestMethod -Uri "http://localhost:8080/props").default_generation_settings.n_ctx
```

Expected output: `262144`. If the server is down, start it or mark this task blocked — do not fake success.

- [ ] **Step 2: Exercise cloudcode against it**

Configure a temporary provider pointing at the live server (do not overwrite the user's real `~/.cloudcode/providers.json`; back it up first and restore after, or use `CLOUDCODE_CONFIG_DIR` if supported — check `src/agent/providers.ts:15` `configDir()`; if no env override exists, back up and restore the file manually):

```json
{
  "llama": {
    "kind": "openai",
    "baseUrl": "http://localhost:8080",
    "apiKey": "none",
    "model": "<the model id shown by http://localhost:8080/v1/models>"
  }
}
```

Then run `npm run dev -- --provider llama`, submit any message, and run `/context`.

Expected: `/context` header shows the total as `262.1k` tokens (i.e. `fmtK(262144)`), not `200k`. That confirms the detected window flowed through to the UI meter.

Also verify precedence: set `"model_context_window": 8192` on the `llama` entry, restart, and confirm `/context` shows `8.2k` — the manual value won and no request to `/props` matters.

Restore `providers.json` afterwards.

- [ ] **Step 3: Record the result**

No commit (no file changes). Report the observed `/context` totals for both runs to the requester before declaring the plan complete.
