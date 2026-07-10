# Model Listing from Provider APIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch the provider's model list (`GET {baseUrl}/v1/models` or Anthropic's `/v1/models`) at session creation and surface it in `/model` (list + completion) and `/config model` completion.

**Architecture:** New pure module `src/agent/models.ts` does the HTTP fetch and parsing. `App.tsx` refreshes a `useRef<string[]>` cache fire-and-forget in `createSession` and exposes `availableModels()` (plus `currentModel()` on `CommandContext`) through both contexts. `builtins.ts` consumes them in `/model` and `/config`.

**Tech Stack:** TypeScript, Ink, vitest, global `fetch` (Node ≥ 18), `AbortSignal.timeout`.

## Global Constraints

- All code, comments, and identifiers in English only.
- ESM imports with explicit `.js` extensions.
- Run tests with `npx vitest run <file>`; full suite `npx vitest run`; typecheck `npx tsc --noEmit`.
- Fetch failures are silent: resolve `[]`, never throw to callers, no user-facing errors from the background fetch.

---

### Task 1: models module

**Files:**
- Create: `src/agent/models.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` from `src/agent/providers.ts` (`{ baseUrl?: string; apiKey?: string; model?: string }`).
- Produces: `fetchModels(provider: ProviderConfig, fetchFn: typeof fetch = fetch): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchModels } from "../src/agent/models.js";

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe("fetchModels", () => {
  it("queries {baseUrl}/v1/models with a bearer token when apiKey is set", async () => {
    const fetchFn = ok({ data: [{ id: "llama-3" }, { id: "qwen-2.5" }] });
    const models = await fetchModels({ baseUrl: "http://localhost:8080", apiKey: "sk-x" }, fetchFn as never);
    expect(models).toEqual(["llama-3", "qwen-2.5"]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:8080/v1/models");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-x" });
  });

  it("omits the Authorization header when apiKey is unset", async () => {
    const fetchFn = ok({ data: [] });
    await fetchModels({ baseUrl: "http://localhost:8080" }, fetchFn as never);
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchFn = ok({ data: [] });
    await fetchModels({ baseUrl: "http://localhost:8080/" }, fetchFn as never);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/v1/models");
  });

  it("queries the Anthropic API with x-api-key when no baseUrl", async () => {
    const fetchFn = ok({ data: [{ id: "claude-sonnet-5" }] });
    const models = await fetchModels({ apiKey: "sk-ant" }, fetchFn as never);
    expect(models).toEqual(["claude-sonnet-5"]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
  });

  it("falls back to ANTHROPIC_API_KEY env for the anthropic provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const fetchFn = ok({ data: [] });
    await fetchModels({}, fetchFn as never);
    expect(fetchFn.mock.calls[0][1].headers).toMatchObject({ "x-api-key": "sk-env" });
    vi.unstubAllEnvs();
  });

  it("resolves [] without a request when anthropic has no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const fetchFn = ok({ data: [] });
    expect(await fetchModels({}, fetchFn as never)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("resolves [] on non-OK status", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchModels({ baseUrl: "http://x" }, fetchFn as never)).toEqual([]);
  });

  it("resolves [] on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await fetchModels({ baseUrl: "http://x" }, fetchFn as never)).toEqual([]);
  });

  it("resolves [] on malformed body and skips entries without string ids", async () => {
    const bad = ok({ nope: true });
    expect(await fetchModels({ baseUrl: "http://x" }, bad as never)).toEqual([]);
    const mixed = ok({ data: [{ id: "good" }, { id: 42 }, "junk"] });
    expect(await fetchModels({ baseUrl: "http://x" }, mixed as never)).toEqual(["good"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/models.test.ts`
Expected: FAIL — module `../src/agent/models.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/agent/models.ts`:

```ts
import type { ProviderConfig } from "./providers.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/models";

// Both the OpenAI-compatible and Anthropic model endpoints return
// { data: [{ id: string }, ...] }.
function parseIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(entry => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function fetchModels(
  provider: ProviderConfig,
  fetchFn: typeof fetch = fetch
): Promise<string[]> {
  let url: string;
  const headers: Record<string, string> = {};
  if (provider.baseUrl) {
    url = `${provider.baseUrl.replace(/\/$/, "")}/v1/models`;
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  } else {
    const key = provider.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return [];
    url = ANTHROPIC_URL;
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    return parseIds(await res.json());
  } catch {
    // background fetch: model listing is best-effort
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/models.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/models.ts tests/models.test.ts
git commit -m "feat: fetchModels queries provider model list endpoints"
```

---

### Task 2: expose availableModels/currentModel and wire the fetch in App

**Files:**
- Modify: `src/commands/types.ts` (CommandContext)
- Modify: `src/commands/completion.ts` (CompletionContext)
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx`

**Interfaces:**
- Consumes: `fetchModels(provider, fetchFn?)` from Task 1.
- Produces: `CommandContext.availableModels(): string[]`, `CommandContext.currentModel(): string | undefined`, `CompletionContext.availableModels(): string[]`. Task 3's builtins rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Add to `tests/app.test.tsx` inside `describe("App")`. It stubs the models module, so add at the top of the file (after imports):

```tsx
import { fetchModels } from "../src/agent/models.js";

vi.mock("../src/agent/models.js", () => ({
  fetchModels: vi.fn().mockResolvedValue(["model-a", "model-b"])
}));
```

Test:

```tsx
  it("fetches the provider model list on session creation", async () => {
    makeApp();
    await wait(50);
    expect(vi.mocked(fetchModels)).toHaveBeenCalledWith({});
  });
```

Note: `makeApp()` uses provider `anthropic: {}`, so `fetchModels` receives `{}`. End-to-end completion through the UI is covered by Task 3's test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx`
Expected: FAIL — `fetchModels` not called (App does not import the module yet). Typecheck of the new context methods also fails until implemented.

- [ ] **Step 3: Implement context and App changes**

In `src/commands/types.ts` add to `CommandContext`:

```ts
  availableModels(): string[];
  currentModel(): string | undefined;
```

In `src/commands/completion.ts` add to `CompletionContext`:

```ts
  availableModels(): string[];
```

In `src/ui/App.tsx`:

Add import:

```ts
import { fetchModels } from "../agent/models.js";
```

Add the ref near the other refs:

```ts
  const availableModelsRef = useRef<string[]>([]);
```

At the top of `createSession` (before constructing `AgentSession`):

```ts
    availableModelsRef.current = [];
    void fetchModels(props.providers[name] ?? {}).then(models => {
      availableModelsRef.current = models;
    });
```

Add to `completionCtx`:

```ts
    availableModels: () => availableModelsRef.current,
```

Add to `ctx` (the `CommandContext`):

```ts
    availableModels: () => availableModelsRef.current,
    currentModel: () => model,
```

In `tests/commands.test.ts`, extend `mockCtx()` so the type still checks (Task 3 adjusts behavior-level tests):

```ts
    availableModels: vi.fn().mockReturnValue([]),
    currentModel: vi.fn().mockReturnValue(undefined),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/completion.ts src/ui/App.tsx tests/app.test.tsx tests/commands.test.ts
git commit -m "feat: fetch provider model list on session creation"
```

---

### Task 3: /model listing + completion, /config model completion

**Files:**
- Modify: `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `ctx.availableModels()`, `ctx.currentModel()` (Task 2); `cctx.availableModels()` in `completeArgs`.
- Produces: `/model` no-arg listing, `/model` `completeArgs`, `/config` model-value completion.

- [ ] **Step 1: Write the failing tests**

Add to `tests/app.test.tsx` inside `describe("App")` (end-to-end completion through the UI; `fetchModels` is already mocked to return `["model-a", "model-b"]`):

```tsx
  it("completes /model from the fetched list in the UI", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait(50);
    stdin.write("/model model-");
    await wait(50);
    expect(lastFrame()).toContain("model-a");
    expect(lastFrame()).toContain("model-b");
  });
```

In `tests/commands.test.ts`, replace the existing `/model` test:

```ts
  it("/model with arg sets model; without arg lists fetched models", async () => {
    const reg = buildRegistry();
    const ctx = mockCtx();
    await reg.get("model")!.run(ctx, "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    vi.mocked(ctx.availableModels).mockReturnValue(["m-one", "m-two"]);
    vi.mocked(ctx.currentModel).mockReturnValue("m-two");
    await reg.get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("  m-one\n● m-two");
  });

  it("/model without arg falls back to usage when no list is available", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(
      "Usage: /model <model-name> (model list unavailable for this provider)"
    );
  });

  it("/model completes from the fetched list", () => {
    const cmd = buildRegistry().get("model")!;
    const cctx = { availableModels: () => ["llama-3", "qwen-2.5"] } as never;
    expect(cmd.completeArgs!("ll", cctx)).toEqual(["llama-3"]);
  });
```

And in the `/config` describe block, replace the completion test's model line:

```ts
  it("completes keys and values", () => {
    const cmd = buildRegistry().get("config")!;
    const cctx = { providerNames: () => ["anthropic", "local"], availableModels: () => ["claude-sonnet-5"] } as never;
    expect(cmd.completeArgs!("p", cctx)).toEqual(["provider", "permissionMode"]);
    expect(cmd.completeArgs!("theme m", cctx)).toEqual(["theme mono"]);
    expect(cmd.completeArgs!("provider l", cctx)).toEqual(["provider local"]);
    expect(cmd.completeArgs!("model cla", cctx)).toEqual(["model claude-sonnet-5"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts tests/app.test.tsx`
Expected: FAIL — 5 failures (listing, fallback, /model completion, /config model completion, UI completion).

- [ ] **Step 3: Implement**

In `src/commands/builtins.ts`, replace the `model` command with:

```ts
  {
    name: "model",
    description: "Switch model: /model <model-name>; no arg lists available models",
    async run(ctx, args) {
      if (!args) {
        const models = ctx.availableModels();
        if (models.length === 0) {
          ctx.notice("Usage: /model <model-name> (model list unavailable for this provider)");
          return;
        }
        const current = ctx.currentModel();
        ctx.notice(models.map(m => `${m === current ? "●" : " "} ${m}`).join("\n"));
        return;
      }
      saveSetting("model", args);
      await ctx.setModel(args);
      ctx.notice(`Model set to ${args}.`);
    },
    completeArgs(prefix, cctx) {
      return cctx.availableModels().filter(m => m.startsWith(prefix));
    }
  },
```

In the `config` command's `completeArgs`, change the `values` expression to:

```ts
      const values =
        key === "provider" ? cctx.providerNames() :
        key === "permissionMode" ? MODES :
        key === "theme" ? Object.keys(THEMES) :
        key === "model" ? cctx.availableModels() : [];
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Manual smoke check**

With a llama-cpp server running: start cloudcode with `--provider llama-cpp`, type `/model ` and Tab — server models should complete; bare `/model` lists them with `●` on the current one. (Leave for human if no server is running.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/builtins.ts tests/commands.test.ts tests/app.test.tsx
git commit -m "feat: /model lists and completes provider models"
```
