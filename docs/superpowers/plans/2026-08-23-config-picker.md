# /config Interactive Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/config` open a two-step picker overlay (pick a setting, then pick a valid value) and show valid options inline when the typed form omits a value.

**Architecture:** New `"config"` mode in `OverlayManager` following the existing resume/statusline overlay patterns, wired through `appPickers.ts` and `CommandContext`. The typed command body is refactored so typed input and picker picks funnel through one exported `applyConfigValue` function; choice lists come from one shared `configChoices` helper so validation never lives in two places.

**Tech Stack:** TypeScript 7 (strict), vitest, oxlint. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-config-picker-design.md`

## Global Constraints

- All code, comments, identifiers in English only.
- `tsconfig.json` stays `"strict": true`; no `any`, no non-null (`!`) assertions.
- No file in `src/` past ~600 lines (`npm run lint:size` enforces).
- No new try/catch boundaries — errors surface through the existing per-command `.catch` in `ui/nativeApp.ts`.
- Tests land in the same commit as the feature code they cover.
- Run full verification before each commit's completion claim: `npm run lint && npm run lint:size && npm run test`.

---

### Task 1: Extract `applyConfigValue` and shared option helpers in builtins.ts

Pure refactor — behavior must not change. This creates the single apply path that Task 2's picker wiring will call.

**Files:**
- Modify: `src/commands/builtins.ts` (config command, lines ~33–34 and ~100–190)

**Interfaces:**
- Consumes: existing module-local `CONFIG_KEYS`, `MODES`, `configValue`, and imports already present in the file.
- Produces (used by Tasks 2 and 4):
  - `export type ConfigKey = (typeof CONFIG_KEYS)[number];`
  - `export function valueOptions(cctx: CommandContext, key: ConfigKey): string[]`
  - `export function currentValue(ctx: CommandContext, key: ConfigKey): string`
  - `export async function applyConfigValue(ctx: CommandContext, key: ConfigKey, value: string): Promise<void>`
  - Requires extending the existing first import to `import type { Command, CommandContext } from "./types.js";`

- [ ] **Step 1: Export the ConfigKey type and add the helpers**

In `src/commands/builtins.ts`, replace:

```ts
const CONFIG_KEYS = ["provider", "model", "permissionMode", "networkMode", "theme", "effort", "autoMemory"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
```

with:

```ts
const CONFIG_KEYS = ["provider", "model", "permissionMode", "networkMode", "theme", "effort", "autoMemory"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
```

Add the import of `CommandContext` (extend the existing first import line):

```ts
import type { Command, CommandContext } from "./types.js";
```

Directly below the existing `configValue` function, add:

```ts
/** Valid values for a config key, from live context where applicable. */
function valueOptions(cctx: CommandContext, key: ConfigKey): string[] {
  switch (key) {
    case "provider": return cctx.providerNames();
    case "model": return cctx.availableModels();
    case "permissionMode": return [...MODES];
    case "networkMode": return ["offlineStrict", "providerOnly"];
    case "theme": return Object.keys(THEMES);
    case "effort": return [...EFFORT_LEVELS];
    case "autoMemory": return ["true", "false"];
  }
}

function currentValue(ctx: CommandContext, key: ConfigKey): string {
  if (key === "networkMode") return ctx.currentNetworkMode();
  return configValue(key);
}

/** Validate + persist + apply live. Shared by the typed /config form and the
 * /config picker overlay so both paths stay identical. */
export async function applyConfigValue(ctx: CommandContext, key: ConfigKey, value: string): Promise<void> {
  switch (key) {
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
      if (value === "bypassPermissions") {
        await ctx.setPermissionMode(value);
        ctx.notice("permissionMode = bypassPermissions (session only, not saved)");
        return;
      }
      saveSetting("permissionMode", value);
      await ctx.setPermissionMode(value as PermissionMode);
      break;
    case "networkMode":
      if (!isPersistedNetworkMode(value)) {
        ctx.notice("Valid saved network modes: offlineStrict, providerOnly. unrestricted is invocation-only.");
        return;
      }
      await ctx.setNetworkMode(value);
      break;
    case "effort":
      if (!isEffortLevel(value)) {
        ctx.notice(`Unknown level: ${value}. Levels: ${EFFORT_LEVELS.join(", ")}`);
        return;
      }
      saveSetting("effort", value);
      await ctx.setEffort(value);
      break;
    case "autoMemory": {
      if (value !== "true" && value !== "false") {
        ctx.notice("Valid values: true, false");
        return;
      }
      saveSetting("autoMemoryEnabled", value === "true");
      break;
    }
    case "theme":
      if (!(value in THEMES)) {
        ctx.notice(`Unknown theme: ${value}. Themes: ${Object.keys(THEMES).join(", ")}`);
        return;
      }
      ctx.setTheme(value);
      break;
  }
  ctx.notice(`${key} = ${value} (saved)`);
}
```

Then replace the entire body of the `config` command's `run` with a delegation that keeps today's behavior:

```ts
    async run(ctx, args) {
      const [key, ...rest] = args.split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!key) {
        ctx.notice(CONFIG_KEYS.map(k => `${k} = ${k === "networkMode" ? ctx.currentNetworkMode() : configValue(k)}`).join("\n"));
        return;
      }
      if (!CONFIG_KEYS.includes(key as ConfigKey)) {
        ctx.notice(`Unknown key: ${key}. Keys: ${CONFIG_KEYS.join(", ")}`);
        return;
      }
      if (!value) {
        ctx.notice(`${key} = ${currentValue(ctx, key as ConfigKey)}`);
        return;
      }
      await applyConfigValue(ctx, key as ConfigKey, value);
    },
```

Leave `completeArgs` untouched in this task (Task 3 can optionally switch it to use `valueOptions`; not required).

- [ ] **Step 2: Run existing tests to verify no behavior changed**

Run: `npx vitest run tests/commands.test.ts tests/completion.test.ts`
Expected: PASS — every existing `/config` test (summary output, per-key get/set, validation errors, `(saved)` notices) must pass unchanged.

- [ ] **Step 3: Lint**

Run: `npm run lint && npm run lint:size`
Expected: no new warnings; builtins.ts still under 600 lines.

- [ ] **Step 4: Commit**

```bash
git add src/commands/builtins.ts
git commit -m "refactor: extract applyConfigValue and value-option helpers from /config"
```

---

### Task 2: `/config` opens the picker; inline hints for the typed form

**Files:**
- Modify: `src/commands/types.ts` (add one method to `CommandContext`)
- Modify: `src/commands/builtins.ts` (`configChoices` export + `run` body)
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `valueOptions`, `currentValue`, `applyConfigValue`, `CONFIG_KEYS`, `ConfigKey` from Task 1.
- Produces:
  - `CommandContext.openConfigPicker(): void` (implemented by the App in Task 4).
  - `export interface ConfigEntry { key: ConfigKey; current: string; choices: string[]; }`
  - `export function configChoices(cctx: CommandContext): ConfigEntry[]` — consumed by Task 4's nativeApp wiring.

- [ ] **Step 1: Write the failing tests**

In `tests/commands.test.ts`:

First, add to `mockCtx()` (after `openStatusLinePicker: vi.fn(),`):

```ts
    openConfigPicker: vi.fn(),
```

Second, replace the test `"lists all keys with persisted values when no arg is given"` with:

```ts
  it("opens the picker when no arg is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({ provider: "local" });
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "");
    expect(ctx.openConfigPicker).toHaveBeenCalled();
    expect(ctx.notice).not.toHaveBeenCalled();
  });
```

Third, replace the test `"shows a single key's value"` with:

```ts
  it("shows a key's value plus valid options when no value is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({});
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "theme");
    expect(ctx.notice).toHaveBeenCalledWith(
      expect.stringContaining("theme = dark")
    );
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Valid: "));
    await buildRegistry().get("config")!.run(ctx, "model");
    // Model list unavailable for this mock provider: current value only, no bogus options.
    expect(ctx.notice).toHaveBeenCalledWith("model = (unset)\nValid: ");
  });
```

Note: the second half asserts the exact string `"model = (unset)\nValid: "` because `availableModels()` returns `[]` in `mockCtx`. If you prefer, assert `stringContaining("model = (unset)")` instead — but then also assert the notice contains no theme names, to pin the empty-options behavior.

Fourth, add a `describe` block after the `/config` describe (still inside the file):

```ts
describe("configChoices", () => {
  it("builds entries from live context with current values", async () => {
    const { configChoices } = await import("../src/commands/builtins.js");
    const ctx = mockCtx();
    const entries = configChoices(ctx);
    expect(entries.map(e => e.key)).toEqual([
      "provider", "model", "permissionMode", "networkMode", "theme", "effort", "autoMemory"
    ]);
    const provider = entries.find(e => e.key === "provider")!;
    expect(provider.choices).toEqual(["anthropic", "local"]);
    const theme = entries.find(e => e.key === "theme");
    expect(theme?.current).toBe("dark");
    expect(theme?.choices).toContain("dark");
    const model = entries.find(e => e.key === "model");
    expect(model?.choices).toEqual([]);
  });
});
```

(The non-null assertions above are on `find()` results inside tests; if oxlint flags them, rewrite with guards: `const provider = entries.find(...); if (!provider) throw new Error("missing provider entry");`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — `openConfigPicker` missing from `CommandContext` (type error at compile/test time), old summary test replaced, `configChoices` not exported.

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to the `CommandContext` interface (next to `openStatusLinePicker(): void;`):

```ts
  /** Opens the interactive settings picker (/config with no arguments). */
  openConfigPicker(): void;
```

In `src/commands/builtins.ts`, add below `currentValue`:

```ts
export interface ConfigEntry {
  key: ConfigKey;
  current: string;
  choices: string[];
}

/** Everything the /config picker overlay needs, computed once at open time. */
export function configChoices(cctx: CommandContext): ConfigEntry[] {
  return CONFIG_KEYS.map(key => ({
    key,
    current: currentValue(cctx, key),
    choices: valueOptions(cctx, key)
  }));
}
```

Change the `config` command's description to:

```ts
    description: "Get/set startup defaults; bare /config opens a picker",
```

Change the `!key` and `!value` branches of `run` to:

```ts
      if (!key) {
        ctx.openConfigPicker();
        return;
      }
      if (!CONFIG_KEYS.includes(key as ConfigKey)) {
        ctx.notice(`Unknown key: ${key}. Keys: ${CONFIG_KEYS.join(", ")}`);
        return;
      }
      if (!value) {
        const options = valueOptions(ctx, key as ConfigKey);
        ctx.notice(`${key} = ${currentValue(ctx, key as ConfigKey)}\nValid: ${options.join(", ")}`);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS, including all untouched `/config` set/validation tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat(config): bare /config requests picker; typed hints list valid values"
```

---

### Task 3: `"config"` mode in OverlayManager

**Files:**
- Modify: `src/ui/widgets/overlay.ts`
- Test: `tests/overlay.test.ts`

**Interfaces:**
- Produces (consumed by Task 4):
  - `OverlayMode` gains `"config"`.
  - `export interface ConfigEntry { key: string; current: string; choices: string[]; }` — structurally compatible with the commands-side `ConfigEntry`.
  - `openConfig(entries: ConfigEntry[], onPick: (key: string, value: string) => void, onCancel: () => void): void`

Note: keep this task self-contained — do NOT import anything from `commands/` into `overlay.ts` (the ui layer must not depend on the command layer).

- [ ] **Step 1: Write the failing tests**

Append to `tests/overlay.test.ts`:

```ts
const configEntries = [
  { key: "theme", current: "dark", choices: ["dark", "light"] },
  { key: "effort", current: "off", choices: ["off", "low", "medium", "high"] },
  { key: "model", current: "(unset)", choices: [] }
];

describe("OverlayManager config sub-mode", () => {
  it("phase 1 lists keys; Enter moves to phase 2; picking applies and closes", () => {
    const mgr = new OverlayManager();
    const onPick = vi.fn();
    mgr.openConfig(configEntries, onPick, () => {});
    expect(mgr.mode).toBe("config");
    mgr.handleKey({ t: "down" });          // select effort
    mgr.handleKey({ t: "enter" });         // -> values phase
    expect(mgr.mode).toBe("config");       // still open
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });          // select medium
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith("effort", "medium");
    expect(mgr.mode).toBe("none");
  });

  it("Esc in values phase returns to keys; Esc on keys cancels", () => {
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openConfig(configEntries, () => {}, onCancel);
    mgr.handleKey({ t: "enter" });         // -> values for theme
    mgr.handleKey({ t: "esc" });           // back to keys
    expect(onCancel).not.toHaveBeenCalled();
    mgr.handleKey({ t: "esc" });           // close
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mgr.mode).toBe("none");
  });

  it("Enter on an entry without choices does nothing and stays open", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openConfig(configEntries, onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });          // model, empty choices
    mgr.handleKey({ t: "enter" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(mgr.mode).toBe("config");       // still open in phase 1
  });

  it("renders keys with current values in phase 1 and marks the current choice in phase 2", () => {
    const mgr = new OverlayManager();
    mgr.openConfig(configEntries, () => {}, () => {});
    const keysRows = mgr.render(theme, 80).map(strip).join("\n");
    expect(keysRows).toContain("theme");
    expect(keysRows).toContain("dark");
    mgr.handleKey({ t: "enter" });         // -> values for theme
    const valueRows = mgr.render(theme, 80).map(strip).join("\n");
    expect(valueRows).toContain("● dark");
    expect(valueRows).toContain("light");
    expect(valueRows).not.toContain("effort");
  });
});
```

Implementation note: entries with empty `choices` never enter the values phase — Enter on them is a no-op and the overlay stays open in phase 1. This is how "model list unavailable" is handled (the spec's "(unavailable)" case); phase 2 is unreachable rather than rendered empty.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — `openConfig` does not exist (TS error).

- [ ] **Step 3: Implement the overlay mode**

In `src/ui/widgets/overlay.ts`:

Extend the mode union:

```ts
export type OverlayMode = "none" | "resume" | "project" | "permission" | "memory" | "trust" | "statusline" | "config";
```

Add near the other state interfaces:

```ts
export interface ConfigEntry {
  key: string;
  current: string;
  choices: string[];
}

interface ConfigState {
  entries: ConfigEntry[];
  phase: "keys" | "values";
  keyIndex: number;
  valueIndex: number;
  activeKey: ConfigEntry | undefined;
  onPick: (key: string, value: string) => void;
  onCancel: () => void;
}
```

Add the field, opener, dispatch arms, handler and renderer. Field (next to `statusLineState`):

```ts
  private configState: ConfigState | undefined;
```

Opener (after `openStatusLine`):

```ts
  openConfig(
    entries: ConfigEntry[],
    onPick: (key: string, value: string) => void,
    onCancel: () => void
  ): void {
    this._mode = "config";
    this.configState = { entries, phase: "keys", keyIndex: 0, valueIndex: 0, activeKey: undefined, onPick, onCancel };
  }
```

In `close()`, add `this.configState = undefined;`. In `handleKey`, add:

```ts
    else if (this._mode === "config") this.handleConfigKey(k);
```

In `render`, add: `if (this._mode === "config") return this.renderConfig(theme, width);`

Handler:

```ts
  private handleConfigKey(k: Key): void {
    const s = this.configState;
    if (!s) return;
    if (s.phase === "keys") {
      if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
      if (k.t === "up") { s.keyIndex = Math.max(0, s.keyIndex - 1); return; }
      if (k.t === "down") { s.keyIndex = Math.min(s.entries.length - 1, s.keyIndex + 1); return; }
      if (k.t === "enter") {
        const entry = s.entries[s.keyIndex];
        if (entry && entry.choices.length > 0) {
          s.activeKey = entry;
          s.valueIndex = Math.max(0, entry.choices.indexOf(entry.current));
          s.phase = "values";
        }
      }
      return;
    }
    if (k.t === "esc") {
      s.phase = "keys";
      s.activeKey = undefined;
      s.valueIndex = 0;
      return;
    }
    if (k.t === "up") { s.valueIndex = Math.max(0, s.valueIndex - 1); return; }
    if (k.t === "down") {
      if (s.activeKey) s.valueIndex = Math.min(s.activeKey.choices.length - 1, s.valueIndex + 1);
      return;
    }
    if (k.t === "enter") {
      const value = s.activeKey?.choices[s.valueIndex];
      if (s.activeKey && value !== undefined) {
        const cb = s.onPick;
        const key = s.activeKey.key;
        this.close();
        cb(key, value);
      }
    }
  }
```

Renderer (after `renderResume`):

```ts
  private renderConfig(theme: Theme, width: number): string[] {
    const s = this.configState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      s.phase === "keys"
        ? `${warning}Settings (↑/↓ move, Enter choose, Esc done)${SGR_RESET}`
        : `${warning}Settings — ${s.activeKey?.key ?? ""} (↑/↓ move, Enter apply, Esc back)${SGR_RESET}`
    ];
    if (s.phase === "keys") {
      const { start, end } = visibleWindow(s.entries.length, s.keyIndex, MAX_ROWS);
      for (let i = start; i < end; i++) {
        const e = s.entries[i];
        const line = `${e.key.padEnd(16)}${e.choices.length === 0 ? `${muted}${e.current}${SGR_RESET}` : e.current}`;
        rows.push(i === s.keyIndex ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
      }
    } else if (s.activeKey) {
      const { start, end } = visibleWindow(s.activeKey.choices.length, s.valueIndex, MAX_ROWS);
      for (let i = start; i < end; i++) {
        const choice = s.activeKey.choices[i];
        const line = `${choice === s.activeKey.current ? "●" : " "} ${choice}`;
        rows.push(i === s.valueIndex ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
      }
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/overlay.test.ts tests/appPickers.test.ts`
Expected: PASS (existing modes unaffected).

- [ ] **Step 5: Size check and commit**

Run: `npm run lint:size`
Expected: `overlay.ts` reported under 600 lines.

```bash
git add src/ui/widgets/overlay.ts tests/overlay.test.ts
git commit -m "feat(ui): two-phase settings picker overlay mode"
```

---

### Task 4: Wire the picker through appPickers and nativeApp

**Files:**
- Modify: `src/ui/appPickers.ts`
- Modify: `src/ui/nativeApp.ts` (the `createCtx` object, near line 332)
- Test: `tests/appPickers.test.ts`

**Interfaces:**
- Consumes: `openConfig(entries, onPick, onCancel)` + `ConfigEntry` from Task 3; `configChoices`, `applyConfigValue`, `ConfigKey` from Tasks 1–2; `PickerDeps` from appPickers.
- Produces: working end-to-end `/config` picker.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe("appPickers", ...)` in `tests/appPickers.test.ts` (and extend its import line to include `openConfigPicker`):

```ts
import { openResumePicker, openProjectPicker, openMemoryPicker, openStatusLinePicker, openConfigPicker, type PickerDeps } from "../src/ui/appPickers.js";
```

```ts
  it("openConfigPicker opens the settings picker, repaints once, forwards picks", () => {
    const { deps, overlay, repaints } = setup();
    const picks: Array<[string, string]> = [];
    openConfigPicker(deps, [{ key: "theme", current: "dark", choices: ["dark", "light"] }], (k, v) => picks.push([k, v]));
    expect(overlay.mode).toBe("config");
    expect(repaints()).toBe(1);
    overlay.handleKey({ t: "enter" });   // -> values phase
    overlay.handleKey({ t: "enter" });   // pick current value
    expect(picks).toEqual([["theme", "dark"]]);
    expect(overlay.mode).toBe("none");
  });

  it("openConfigPicker Esc cancels and repaints twice total", () => {
    const { deps, overlay, repaints } = setup();
    openConfigPicker(deps, [], () => {});
    overlay.handleKey({ t: "esc" });
    expect(overlay.mode).toBe("none");
    expect(repaints()).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/appPickers.test.ts`
Expected: FAIL — `openConfigPicker` is not exported.

- [ ] **Step 3: Implement the wiring**

In `src/ui/appPickers.ts`, add the `ConfigEntry` type import:

```ts
import type { ConfigEntry, OverlayManager } from "./widgets/overlay.js";
```

(replacing the existing `import type { OverlayManager } from "./widgets/overlay.js";`). Add the function after `openStatusLinePicker`:

```ts
/** Settings picker for bare /config: entries are computed by the caller
 * (configChoices) at open time; picks are applied by the caller's callback. */
export function openConfigPicker(
  deps: PickerDeps,
  entries: ConfigEntry[],
  onPick: (key: string, value: string) => void
): void {
  deps.overlay.openConfig(entries, onPick, cancel(deps));
  deps.recompute();
}
```

Also update the doc comment above `PickerDeps` to mention `/config` alongside `/resume`, `/project`, `/memory`, `/statusline`.

In `src/ui/nativeApp.ts`, add to the imports from commands (there is already a `commands/...` import section — follow its style):

```ts
import { applyConfigValue, configChoices, type ConfigKey } from "../commands/builtins.js";
```

and extend the existing `./appPickers.js` import to include `openConfigPicker`.

Inside the ctx object (next to `openStatusLinePicker`, around line 367), add:

```ts
      openConfigPicker: () =>
        openConfigPicker(this.pickerDeps(), configChoices(this.ctx), (key, value) => {
          void applyConfigValue(this.ctx, key as ConfigKey, value);
        }),
```

If `this.ctx` is not yet assigned when the factory runs: that is safe here because both callbacks fire only after user interaction, mirroring the existing `openProjectPicker: () => openProjectPicker(this.pickerDeps(), path => this.ctx.switchProject(path))` pattern at line 364. Verify the field name holding the ctx object in nativeApp.ts is actually `this.ctx`; adjust the references if it differs.

The `key as ConfigKey` cast is safe because `configChoices` only produces `ConfigKey` keys; add no other casts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/appPickers.test.ts tests/app.test.ts tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run: `npm run lint && npm run lint:size && npx tsc -p tsconfig.json --noEmit && npm run test`
Expected: clean.

Manual smoke check (optional but recommended): `npm run dev`, type `/config`, confirm the picker opens, change the theme via Enter-Esc navigation, and confirm `theme = <name> (saved)` appears.

```bash
git add src/ui/appPickers.ts src/ui/nativeApp.ts tests/appPickers.test.ts
git commit -m "feat(config): wire settings picker into /config via CommandContext"
```
