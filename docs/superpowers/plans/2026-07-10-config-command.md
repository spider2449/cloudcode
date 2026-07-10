# /config Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/config <key> [value]` to read/write persisted startup defaults (provider, model, permissionMode, theme) and apply them live and at startup.

**Architecture:** New `src/agent/settings.ts` persists `{provider, model, permissionMode}` to `~/.cloudcode/settings.json` (theme stays in `theme.json`). The `/config` builtin validates, persists via the settings module, and live-applies via existing `CommandContext` methods — no context changes. `src/cli.tsx` loads settings at startup; `App` gains `initialModel`/`initialMode` props.

**Tech Stack:** TypeScript, Ink, vitest, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- All code, comments, and identifiers in English only.
- ESM imports with explicit `.js` extensions.
- Run tests with `npx vitest run <file>`; full suite `npx vitest run`; typecheck `npx tsc --noEmit`.
- Theme is never written to `settings.json` — `/config theme` delegates to the existing theme persistence.

---

### Task 1: Settings module

**Files:**
- Create: `src/agent/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.ts`; `PermissionMode` type from `src/agent/session.ts`.
- Produces:
  - `interface Settings { provider?: string; model?: string; permissionMode?: PermissionMode }`
  - `loadSettings(filePath?: string): Settings` — `{}` on missing/corrupt/non-object; drops non-string `provider`/`model` and invalid `permissionMode` values
  - `saveSetting(key: keyof Settings, value: string, filePath?: string): void` — read-modify-write preserving other keys

- [ ] **Step 1: Write the failing tests**

Create `tests/settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSetting } from "../src/agent/settings.js";

const dir = () => mkdtempSync(join(tmpdir(), "settings-"));

describe("settings persistence", () => {
  it("round-trips a saved setting", () => {
    const file = join(dir(), "settings.json");
    saveSetting("provider", "local", file);
    expect(loadSettings(file)).toEqual({ provider: "local" });
  });

  it("preserves other keys on save", () => {
    const file = join(dir(), "settings.json");
    saveSetting("provider", "local", file);
    saveSetting("model", "claude-sonnet-5", file);
    expect(loadSettings(file)).toEqual({ provider: "local", model: "claude-sonnet-5" });
  });

  it("returns empty settings when the file is missing", () => {
    expect(loadSettings(join(dir(), "nope.json"))).toEqual({});
  });

  it("returns empty settings when the file is corrupt", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, "not json{{");
    expect(loadSettings(file)).toEqual({});
  });

  it("drops invalid field shapes", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ provider: 42, model: ["x"], permissionMode: "yolo" }));
    expect(loadSettings(file)).toEqual({});
  });

  it("keeps a valid permissionMode", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "acceptEdits" }));
    expect(loadSettings(file)).toEqual({ permissionMode: "acceptEdits" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — module `../src/agent/settings.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/agent/settings.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import type { PermissionMode } from "./session.js";

export interface Settings {
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

const VALID_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
const DEFAULT_FILE = () => join(configDir(), "settings.json");

export function loadSettings(filePath: string = DEFAULT_FILE()): Settings {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const out: Settings = {};
    if (typeof raw.provider === "string") out.provider = raw.provider;
    if (typeof raw.model === "string") out.model = raw.model;
    if (VALID_MODES.includes(raw.permissionMode)) out.permissionMode = raw.permissionMode;
    return out;
  } catch {
    // missing or invalid file: no persisted settings
    return {};
  }
}

export function saveSetting(key: keyof Settings, value: string, filePath: string = DEFAULT_FILE()): void {
  const next = { ...loadSettings(filePath), [key]: value };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/settings.ts tests/settings.test.ts
git commit -m "feat: settings module for persisted startup defaults"
```

---

### Task 2: /config builtin

**Files:**
- Modify: `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `loadSettings`/`saveSetting` from `src/agent/settings.ts` (Task 1); `THEMES`, `loadThemeName` from `src/ui/theme.ts`; existing ctx methods `providerNames`, `switchProvider`, `setModel`, `setPermissionMode`, `setTheme`, `notice`; the file-local `MODES` constant in builtins.ts.
- Produces: builtin `config` in the registry with `completeArgs` (keys for the first token; values for `provider`/`permissionMode`/`theme` second tokens, returned as `"<key> <value>"` because completion replaces the whole args region — see `argumentSuggestions` in `src/commands/completion.ts`).

- [ ] **Step 1: Write the failing tests**

In `tests/commands.test.ts`, mock the settings and theme persistence at the top of the file (after the existing imports):

```ts
import { loadSettings, saveSetting } from "../src/agent/settings.js";
import { loadThemeName } from "../src/ui/theme.js";

vi.mock("../src/agent/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({}),
  saveSetting: vi.fn()
}));
vi.mock("../src/ui/theme.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ui/theme.js")>()),
  loadThemeName: vi.fn().mockReturnValue("dark")
}));
```

Add the test block:

```ts
describe("/config", () => {
  it("lists all keys with persisted values when no arg is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({ provider: "local" });
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(
      "provider = local\nmodel = (unset)\npermissionMode = (unset)\ntheme = dark"
    );
  });

  it("shows a single key's value", async () => {
    vi.mocked(loadSettings).mockReturnValue({});
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "model");
    expect(ctx.notice).toHaveBeenCalledWith("model = (unset)");
  });

  it("rejects an unknown key", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "editor vim");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown key: editor. Keys: provider, model, permissionMode, theme");
  });

  it("sets provider: persists then switches live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider local");
    expect(saveSetting).toHaveBeenCalledWith("provider", "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
    expect(ctx.notice).toHaveBeenCalledWith("provider = local (saved)");
  });

  it("rejects an unknown provider without persisting", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider nope");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.switchProvider).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown provider: nope. Providers: anthropic, local");
  });

  it("sets model: persists then applies live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "model claude-sonnet-5");
    expect(saveSetting).toHaveBeenCalledWith("model", "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(ctx.notice).toHaveBeenCalledWith("model = claude-sonnet-5 (saved)");
  });

  it("sets permissionMode with validation", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "permissionMode acceptEdits");
    expect(saveSetting).toHaveBeenCalledWith("permissionMode", "acceptEdits");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    await buildRegistry().get("config")!.run(ctx, "permissionMode yolo");
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("sets theme by delegating to setTheme, never touching settings.json", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "theme mono");
    expect(ctx.setTheme).toHaveBeenCalledWith("mono");
    expect(saveSetting).not.toHaveBeenCalledWith("theme", expect.anything());
    expect(ctx.notice).toHaveBeenCalledWith("theme = mono (saved)");
    await buildRegistry().get("config")!.run(ctx, "theme solarized");
    expect(ctx.setTheme).not.toHaveBeenCalledWith("solarized");
    expect(ctx.notice).toHaveBeenCalledWith("Unknown theme: solarized. Themes: dark, light, mono");
  });

  it("completes keys and values", () => {
    const cmd = buildRegistry().get("config")!;
    const cctx = { providerNames: () => ["anthropic", "local"] } as never;
    expect(cmd.completeArgs!("p", cctx)).toEqual(["provider", "permissionMode"]);
    expect(cmd.completeArgs!("theme m", cctx)).toEqual(["theme mono"]);
    expect(cmd.completeArgs!("provider l", cctx)).toEqual(["provider local"]);
    expect(cmd.completeArgs!("model cla", cctx)).toEqual([]);
  });
});
```

Add `beforeEach` cleanup: change the existing vitest import line to include `beforeEach` and add near the top of the file:

```ts
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadSettings).mockReturnValue({}); vi.mocked(loadThemeName).mockReturnValue("dark"); });
```

Note: `mockCtx()` re-creates fresh `vi.fn()`s per call, but `costSummary`-style return values configured with `mockReturnValue` inside `mockCtx()` are unaffected by `clearAllMocks` running before each test. Verify the whole file still passes after adding the hook; if any pre-existing test relied on call history across tests (none currently do), fix locally.

Update the registry-names assertion:

```ts
    expect(names).toEqual(["clear", "compact", "config", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "skills", "theme"]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — `config` command missing.

- [ ] **Step 3: Implement the builtin**

In `src/commands/builtins.ts`, add imports:

```ts
import { loadSettings, saveSetting, type Settings } from "../agent/settings.js";
import { loadThemeName } from "../ui/theme.js";
```

(`THEMES` is already imported.) Add above the `commands` array:

```ts
const CONFIG_KEYS = ["provider", "model", "permissionMode", "theme"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function configValue(key: ConfigKey): string {
  if (key === "theme") return loadThemeName();
  return loadSettings()[key as keyof Settings] ?? "(unset)";
}
```

Insert the command into the `commands` array (after `compact`):

```ts
  {
    name: "config",
    description: "Get/set startup defaults: /config [provider|model|permissionMode|theme] [value]",
    async run(ctx, args) {
      const [key, ...rest] = args.split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!key) {
        ctx.notice(CONFIG_KEYS.map(k => `${k} = ${configValue(k)}`).join("\n"));
        return;
      }
      if (!CONFIG_KEYS.includes(key as ConfigKey)) {
        ctx.notice(`Unknown key: ${key}. Keys: ${CONFIG_KEYS.join(", ")}`);
        return;
      }
      if (!value) {
        ctx.notice(`${key} = ${configValue(key as ConfigKey)}`);
        return;
      }
      switch (key as ConfigKey) {
        case "provider":
          if (!ctx.providerNames().includes(value)) {
            ctx.notice(`Unknown provider: ${value}. Providers: ${ctx.providerNames().join(", ")}`);
            return;
          }
          saveSetting("provider", value);
          await ctx.switchProvider(value);
          break;
        case "model":
          saveSetting("model", value);
          await ctx.setModel(value);
          break;
        case "permissionMode":
          if (!MODES.includes(value as PermissionMode)) {
            ctx.notice("Valid modes: default, acceptEdits, bypassPermissions");
            return;
          }
          saveSetting("permissionMode", value);
          await ctx.setPermissionMode(value as PermissionMode);
          break;
        case "theme":
          if (!(value in THEMES)) {
            ctx.notice(`Unknown theme: ${value}. Themes: ${Object.keys(THEMES).join(", ")}`);
            return;
          }
          ctx.setTheme(value);
          break;
      }
      ctx.notice(`${key} = ${value} (saved)`);
    },
    completeArgs(prefix, cctx) {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) return CONFIG_KEYS.filter(k => k.startsWith(parts[0] ?? ""));
      const [key, valuePrefix = ""] = parts;
      const values =
        key === "provider" ? cctx.providerNames() :
        key === "permissionMode" ? MODES :
        key === "theme" ? Object.keys(THEMES) : [];
      return values.filter(v => v.startsWith(valuePrefix)).map(v => `${key} ${v}`);
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat: /config builtin to get/set startup defaults"
```

---

### Task 3: Startup wiring (cli.tsx + App props)

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx`

**Interfaces:**
- Consumes: `loadSettings(): Settings` from `src/agent/settings.ts` (Task 1).
- Produces: `AppProps` gains `initialModel?: string` and `initialMode?: PermissionMode`.

- [ ] **Step 1: Write the failing test**

Add to `tests/app.test.tsx` inside `describe("App")`:

```tsx
  it("seeds session model and permission mode from initial props", async () => {
    const captured: Record<string, unknown>[] = [];
    const capturingQueryFn = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      captured.push(args.options);
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) { /* drain */ }
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { lastFrame } = render(
      <App
        cwd="/p"
        providers={{ anthropic: { model: "provider-default" } }}
        initialProvider="anthropic"
        initialModel="my-model"
        initialMode="acceptEdits"
        sessionIndex={index}
        queryFn={capturingQueryFn as never}
      />
    );
    await wait(50);
    expect(captured[0]).toMatchObject({ model: "my-model", permissionMode: "acceptEdits" });
    expect(lastFrame()).toContain("acceptEdits");
    expect(lastFrame()).toContain("my-model");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx`
Expected: FAIL — session options carry `provider-default` and `default`, and the props don't exist (typecheck would also fail).

- [ ] **Step 3: Implement App changes**

In `src/ui/App.tsx`:

Add to `AppProps`:

```ts
  initialModel?: string;
  initialMode?: PermissionMode;
```

Add a helper inside `App` (above `createSession`) and use it everywhere a provider's model is derived:

```ts
  function modelFor(name: string): string | undefined {
    return (name === props.initialProvider ? props.initialModel : undefined) ?? props.providers[name]?.model;
  }
```

Change state initializers:

```ts
  const [model, setModel] = useState<string | undefined>(modelFor(props.initialProvider));
  const [mode, setMode] = useState<PermissionMode>(props.initialMode ?? "default");
```

(Note: `modelFor` must be a function declaration, hoisted, so calling it in the `useState` initializer above is safe.)

In `createSession`, change the `model` option:

```ts
      model: modelFor(name),
```

In `restartSession`, change the model reset line:

```ts
    setModel(modelFor(name));
```

- [ ] **Step 4: Implement cli.tsx changes**

Replace the provider option and validation block in `src/cli.tsx`:

```tsx
import { loadSettings } from "./agent/settings.js";
```

In `parseArgs` options, change `provider` to have no default:

```ts
    provider: { type: "string" },
```

Replace the current validation block (`const providers = loadProviders(); if (!providers[values.provider!]) { ... }`) with:

```tsx
const providers = loadProviders();
const settings = loadSettings();
let providerName = values.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (values.provider) {
    console.error(`Unknown provider "${values.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(1);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}
```

Update the `render` call to pass the new values:

```tsx
render(
  <App
    cwd={cwd}
    providers={providers}
    initialProvider={providerName}
    initialModel={settings.model}
    initialMode={settings.permissionMode}
    resume={resume}
    sessionIndex={sessionIndex}
    openResumeOnStart={values.resume}
  />
);
```

- [ ] **Step 5: Run full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Manual smoke check**

Run the TUI: `/config` (list), `/config model claude-sonnet-5`, `/config permissionMode acceptEdits`, restart and confirm the status bar shows the persisted model and mode; `cloudcode --provider anthropic` still overrides a saved provider. (Skip if running non-interactively; leave for human.)

- [ ] **Step 7: Commit**

```bash
git add src/cli.tsx src/ui/App.tsx tests/app.test.tsx
git commit -m "feat: apply persisted startup defaults in cli and App"
```
