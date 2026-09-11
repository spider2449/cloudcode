# Live /theme (GUI + TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/theme <name>` recolors the running app immediately — full transcript reprint in the TUI, instant CSS-variable switch in the desktop GUI — while both sides keep sharing the same theme names.

**Architecture:** TUI reuses the resize clear-and-reprint path (`buffer.recommitAll()` + `CLEAR_AND_HOME` + `renderer.invalidate()` before `recompute()`). GUI adds one `theme` chat event (generic JSON forwarding in `desktop/main.mjs` already carries it, no main-process change) that the renderer applies via a tested palette map in a new pure module `desktop/renderer/themeState.ts`.

**Tech Stack:** TypeScript (`src/ui/nativeApp.ts`, `src/desktop/*`), React (`desktop/renderer/src.tsx`), CSS variables (`desktop/renderer/style.css`), vitest (`npm test`).

Repo rules that apply to every task: all code comments in English; `tsconfig.json` is `strict` (no `any`, no `!` assertions); every commit bumps the patch version in `src/version.ts`, `package.json`, both `package-lock.json` version fields, and `installer/cloudcode.iss` together (read the current value from `src/version.ts` first; it is 0.1.77 at plan time).

---

### Task 1: `theme` chat event in the protocol

**Files:**
- Modify: `src/desktop/chatProtocol.ts:10` (event vocabulary)
- Modify: `tests/desktop-chatProtocol.test.ts:15` (vocabulary assertion)

- [ ] **Step 1: Write the failing test**

In `tests/desktop-chatProtocol.test.ts`, change line 15 to:

```ts
    expect(CHAT_EVENT_TYPES).toEqual(["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "complete", "new_session", "session_id", "theme", "done"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: FAIL with an array mismatch showing the missing `"theme"` entry.

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/chatProtocol.ts`, change line 10 to:

```ts
export const CHAT_EVENT_TYPES = ["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "complete", "new_session", "session_id", "theme", "done"] as const;
```

The `ChatEvent` interface needs no change: a theme event is `{ id, type: "theme", text: name }` using the existing optional `text` field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/desktop/chatProtocol.ts tests/desktop-chatProtocol.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add theme event to desktop chat protocol (0.1.78)"
```

(Adjust the version to current patch + 1.)

---

### Task 2: GUI command context emits the theme event

**Files:**
- Modify: `src/desktop/guiCommandContext.ts` (interface line 38-61, `setTheme` lines 173-180)
- Modify: `tests/desktop-guiCommandContext.test.ts` (setup deps, new tests)

- [ ] **Step 1: Write the failing tests**

In `tests/desktop-guiCommandContext.test.ts`, extend the `setup()` return and deps. Change the deps object (lines 56-77) to also collect emitted themes: after line 45 (`const notices: string[] = [];`) add `const emittedThemes: string[] = [];`, add to the `deps` literal after the `requestNewSession` line:

```ts
    emitTheme: name => { emittedThemes.push(name); },
```

and change line 86 (`return { notices, errors, session, slash, ctx, newSessionRequests };`) to:

```ts
  return { notices, errors, session, slash, ctx, newSessionRequests, emittedThemes };
```

Append to the end of the file:

```ts
  it("emits a live theme event on /theme", async () => {
    const t = setup();
    await t.slash("/theme dracula");
    expect(t.errors).toEqual([]);
    expect(t.emittedThemes).toEqual(["dracula"]);
    expect(t.notices).toContain("Theme set to dracula.");
  });
  it("emits nothing for unknown theme names", async () => {
    const t = setup();
    await t.slash("/theme nope");
    expect(t.errors).toEqual([]);
    expect(t.emittedThemes).toEqual([]);
    expect(t.notices.some(n => n.includes("Unknown theme: nope"))).toBe(true);
  });
```

Note: these tests sit inside the existing `describe("gui command context against the real registry", ...)` block — append them before its closing `});` on line 139.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/desktop-guiCommandContext.test.ts`
Expected: FAIL with a TypeScript/vitest error that `emitTheme` is missing (the `deps` literal no longer satisfies `GuiCommandDeps`).

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/guiCommandContext.ts`, add to the `GuiCommandDeps` interface after the `requestNewSession` field (line 58):

```ts
  // Pushes a live "theme" chat event to the GUI shell so /theme recolors
  // the running window instead of only persisting for next launch.
  emitTheme(name: string): void;
```

Replace the `setTheme` body (lines 173-180):

```ts
    setTheme: name => {
      if (!THEMES[name]) {
        deps.notice(`Unknown theme: ${name}. Themes: ${Object.keys(THEMES).join(", ")}`);
        return;
      }
      saveThemeName(name);
      deps.emitTheme(name);
      deps.notice(`Theme set to ${name}.`);
    },
```

The old notice text (`Applies to the terminal UI.`) is dropped because it is no longer true.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/desktop-guiCommandContext.test.ts`
Expected: PASS (all 8 tests: 6 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/desktop/guiCommandContext.ts tests/desktop-guiCommandContext.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Emit live theme event from GUI command context (0.1.79)"
```

---

### Task 3: Wire `emitTheme` in the headless backend

**Files:**
- Modify: `src/cli.tsx` (`buildContext`, after the `requestNewSession` field, lines 209-211)

No unit test covers `cli.tsx` wiring directly; verification is `tsc` (the `GuiCommandDeps` type now requires the field, so a missing wire fails the build) plus the Task 2 tests exercising the same interface.

- [ ] **Step 1: Add the emit wiring**

In `src/cli.tsx`, inside `buildContext`, after:

```ts
      requestNewSession: () => {
        emit({ id, type: "new_session" });
      },
```

insert:

```ts
      emitTheme: name => {
        emit({ id, type: "theme", text: name });
      },
```

The `emit` and `id` closures already exist in that scope (see the `notice` wire on line 192). `desktop/main.mjs:43` forwards every backend JSON line to the window generically, so no main-process change is needed.

- [ ] **Step 2: Run checks**

Run: `npm run build`
Expected: `tsc -p tsconfig.json` passes with no errors.

Run: `npx vitest run tests/desktop-guiCommandContext.test.ts tests/desktop-guiServer.test.ts`
Expected: PASS (no regressions in slash dispatch).

- [ ] **Step 3: Commit**

```bash
git add src/cli.tsx src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Wire theme event emission in headless backend (0.1.80)"
```

---

### Task 4: Renderer palette map plus unit tests

**Files:**
- Create: `desktop/renderer/themeState.ts`
- Create: `tests/desktop-themeState.test.ts`

The hex values below are the mode-correct resolved roles (`background`, `backgroundPanel`, `text`, `textMuted`, `accent`, `border`, `error`) dumped from the real `THEMES` registry on 2026-09-11, except `dark`/`light`/`mono` which define no background roles in the TUI schema and therefore keep the GUI's current dark look (dark, mono) or a matching light set (light).

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-themeState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { THEMES } from "../src/ui/theme.js";
import { GUI_THEMES, GUI_THEME_STORAGE_KEY, guiThemeVars, resolveGuiTheme } from "../desktop/renderer/themeState.js";

describe("gui theme palette", () => {
  it("covers every TUI theme name so /theme never misses in the GUI", () => {
    expect(Object.keys(GUI_THEMES).sort()).toEqual(Object.keys(THEMES).sort());
  });
  it("gives every theme a complete non-empty hex var set", () => {
    for (const vars of Object.values(GUI_THEMES)) {
      expect(Object.values(vars)).toHaveLength(7);
      for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
  it("falls back to dark for unknown names", () => {
    expect(resolveGuiTheme("nope")).toBe("dark");
    expect(guiThemeVars("nope")).toEqual(GUI_THEMES.dark);
    expect(guiThemeVars("dracula").accent).toBe("#8be9fd");
  });
  it("uses a stable storage key", () => {
    expect(GUI_THEME_STORAGE_KEY).toBe("cloudcode.theme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-themeState.test.ts`
Expected: FAIL with "Failed to resolve import" (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `desktop/renderer/themeState.ts`:

```ts
// GUI theme state. Pure data plus DOM/storage side effects, kept window-free
// at module scope so node-based unit tests can import this module directly
// (same pattern as lastSelection.ts). Hex values are the resolved TUI roles
// for each builtin theme; dark/mono keep the GUI's established look because
// those TUI definitions carry no background roles.

export interface GuiThemeVars {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  error: strin
...[truncated 9113 chars]