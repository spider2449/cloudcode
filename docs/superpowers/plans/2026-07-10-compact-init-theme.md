# /compact, /init, and /theme Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/compact` and `/init` builtins (forwarded to the Agent SDK) and a `/theme` command backed by a new preset-based theming system.

**Architecture:** `/compact` and `/init` are one-liners that call the existing `ctx.sendPrompt(...)` — the SDK's CLI implements both. `/theme` introduces `src/ui/theme.ts` (presets + persistence to `~/.cloudcode/theme.json`), a React context in `src/ui/ThemeContext.tsx`, migration of all hardcoded Ink color literals to theme slots, and a builtin with arg completion.

**Tech Stack:** TypeScript, Ink (React for terminals), vitest, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- All code, comments, and identifiers in English only.
- ESM imports with explicit `.js` extensions (existing codebase convention).
- Run tests with `npx vitest run <file>`; full suite with `npx vitest run`.

---

### Task 1: /compact and /init builtins

**Files:**
- Modify: `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `CommandContext.sendPrompt(text: string): void` (already exists).
- Produces: builtins named `compact` and `init` in the registry.

- [ ] **Step 1: Write the failing tests**

Add to `tests/commands.test.ts` (and update the registry-names test — it asserts the exact sorted list):

```ts
describe("/compact and /init", () => {
  it("/compact forwards to the SDK", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("compact")!.run(ctx, "");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("/compact");
  });

  it("/init forwards to the SDK", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("init")!.run(ctx, "");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("/init");
  });
});
```

Update the existing assertion in `describe("builtins")`:

```ts
    expect(names).toEqual(["clear", "compact", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "skills"]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — `compact`/`init` lookups return `undefined`, registry-names mismatch.

- [ ] **Step 3: Implement the builtins**

In `src/commands/builtins.ts`, insert into the `commands` array after the `clear` entry:

```ts
  {
    name: "compact",
    description: "Summarize the conversation to free context",
    async run(ctx) { ctx.sendPrompt("/compact"); }
  },
  {
    name: "init",
    description: "Analyze the codebase and generate CLAUDE.md",
    async run(ctx) { ctx.sendPrompt("/init"); }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat: add /compact and /init builtins forwarding to the SDK"
```

---

### Task 2: Theme module (presets + persistence)

**Files:**
- Create: `src/ui/theme.ts`
- Test: `tests/theme.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.ts`.
- Produces:
  - `interface Theme { user; accent; muted; error; success; removed; warning: string }`
  - `THEMES: Record<string, Theme>` with keys `dark`, `light`, `mono`
  - `loadThemeName(filePath?: string): string` — returns a valid preset name, `"dark"` on missing/corrupt file or unknown name
  - `saveThemeName(name: string, filePath?: string): void`

- [ ] **Step 1: Write the failing tests**

Create `tests/theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadThemeName, saveThemeName } from "../src/ui/theme.js";

describe("theme presets", () => {
  it("defines dark, light, and mono", () => {
    expect(Object.keys(THEMES).sort()).toEqual(["dark", "light", "mono"]);
  });

  it("dark preserves the original colors", () => {
    expect(THEMES.dark).toEqual({
      user: "blue", accent: "cyan", muted: "gray",
      error: "red", success: "green", removed: "red", warning: "yellow"
    });
  });
});

describe("theme persistence", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "theme-"));

  it("round-trips a saved theme name", () => {
    const file = join(dir(), "theme.json");
    saveThemeName("light", file);
    expect(loadThemeName(file)).toBe("light");
  });

  it("falls back to dark when the file is missing", () => {
    expect(loadThemeName(join(dir(), "nope.json"))).toBe("dark");
  });

  it("falls back to dark when the file is corrupt", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, "not json{{");
    expect(loadThemeName(file)).toBe("dark");
  });

  it("falls back to dark for an unknown theme name", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, JSON.stringify({ name: "solarized" }));
    expect(loadThemeName(file)).toBe("dark");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/theme.test.ts`
Expected: FAIL — module `../src/ui/theme.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/ui/theme.ts` (persistence mirrors the `History` pattern in `src/agent/history.ts`):

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../agent/providers.js";

export interface Theme {
  user: string;
  accent: string;
  muted: string;
  error: string;
  success: string;
  removed: string;
  warning: string;
}

export const THEMES: Record<string, Theme> = {
  dark: { user: "blue", accent: "cyan", muted: "gray", error: "red", success: "green", removed: "red", warning: "yellow" },
  light: { user: "magenta", accent: "blue", muted: "blackBright", error: "red", success: "green", removed: "red", warning: "magenta" },
  mono: { user: "white", accent: "white", muted: "gray", error: "white", success: "white", removed: "gray", warning: "white" }
};

const DEFAULT_FILE = () => join(configDir(), "theme.json");

export function loadThemeName(filePath: string = DEFAULT_FILE()): string {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (raw && typeof raw.name === "string" && raw.name in THEMES) return raw.name;
  } catch {
    // missing or invalid file: fall through to default
  }
  return "dark";
}

export function saveThemeName(name: string, filePath: string = DEFAULT_FILE()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ name }, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.ts tests/theme.test.ts
git commit -m "feat: theme presets and persistence module"
```

---

### Task 3: /theme builtin and CommandContext additions

**Files:**
- Modify: `src/commands/types.ts`
- Modify: `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `THEMES` from `src/ui/theme.ts` (Task 2).
- Produces:
  - `CommandContext.setTheme(name: string): void` — App will implement (Task 4); switches and persists.
  - `CommandContext.listThemes(): string` — App will implement; multi-line list with the active theme marked.
  - Builtin `theme` with `completeArgs` offering preset names.

- [ ] **Step 1: Write the failing tests**

In `tests/commands.test.ts`, add to `mockCtx()`'s returned object:

```ts
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue("● dark\n  light\n  mono")
```

Add tests:

```ts
describe("/theme", () => {
  it("lists themes when no arg is given", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "");
    expect(ctx.listThemes).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("● dark\n  light\n  mono");
    expect(ctx.setTheme).not.toHaveBeenCalled();
  });

  it("switches to a known theme", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "light");
    expect(ctx.setTheme).toHaveBeenCalledWith("light");
    expect(ctx.notice).toHaveBeenCalledWith("Theme: light");
  });

  it("rejects an unknown theme", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "solarized");
    expect(ctx.setTheme).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown theme: solarized. Themes: dark, light, mono");
  });

  it("completes theme names", () => {
    const cmd = buildRegistry().get("theme")!;
    expect(cmd.completeArgs!("l", {} as never)).toEqual(["light"]);
  });
});
```

Update the registry-names assertion again:

```ts
    expect(names).toEqual(["clear", "compact", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "skills", "theme"]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — `theme` command missing.

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to `CommandContext`:

```ts
  setTheme(name: string): void;
  listThemes(): string;
```

In `src/commands/builtins.ts`, add the import and the command (insert after `skills`):

```ts
import { THEMES } from "../ui/theme.js";
```

```ts
  {
    name: "theme",
    description: "Switch color theme: /theme <dark|light|mono>",
    async run(ctx, args) {
      if (!args) { ctx.notice(ctx.listThemes()); return; }
      if (!(args in THEMES)) {
        ctx.notice(`Unknown theme: ${args}. Themes: ${Object.keys(THEMES).join(", ")}`);
        return;
      }
      ctx.setTheme(args);
      ctx.notice(`Theme: ${args}`);
    },
    completeArgs(prefix) {
      return Object.keys(THEMES).filter(v => v.startsWith(prefix));
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat: /theme builtin with completion and validation"
```

---

### Task 4: ThemeContext, App wiring, and color migration

**Files:**
- Create: `src/ui/ThemeContext.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/MessageList.tsx`, `src/ui/StatusBar.tsx`, `src/ui/WorkingIndicator.tsx`, `src/ui/SuggestionMenu.tsx`, `src/ui/ResumePicker.tsx`, `src/ui/PermissionDialog.tsx`, `src/ui/InputBox.tsx`
- Test: `tests/app.test.tsx` (existing suite must stay green)

**Interfaces:**
- Consumes: `Theme`, `THEMES`, `loadThemeName`, `saveThemeName` from `src/ui/theme.ts`; `CommandContext.setTheme`/`listThemes` shape from Task 3.
- Produces: `ThemeProvider({ theme, children })` and `useTheme(): Theme` from `src/ui/ThemeContext.tsx`.

- [ ] **Step 1: Create the context**

Create `src/ui/ThemeContext.tsx`:

```tsx
import React, { createContext, useContext, type ReactNode } from "react";
import { THEMES, type Theme } from "./theme.js";

const ThemeContext = createContext<Theme>(THEMES.dark);

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
```

- [ ] **Step 2: Wire App.tsx**

In `src/ui/App.tsx`:

Add imports:

```ts
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { ThemeProvider } from "./ThemeContext.js";
```

Add state next to the other `useState` calls:

```ts
const [themeName, setThemeName] = useState(() => loadThemeName());
```

Add to the `ctx: CommandContext` object:

```ts
    setTheme: name => { setThemeName(name); saveThemeName(name); },
    listThemes: () => Object.keys(THEMES).map(n => `${n === themeName ? "●" : " "} ${n}`).join("\n"),
```

Wrap the returned tree (the outer `<Box flexDirection="column">`) in the provider:

```tsx
  return (
    <ThemeProvider theme={THEMES[themeName] ?? THEMES.dark}>
      <Box flexDirection="column">
        {/* existing children unchanged */}
      </Box>
    </ThemeProvider>
  );
```

- [ ] **Step 3: Migrate hardcoded colors to theme slots**

Each component adds `import { useTheme } from "./ThemeContext.js";` and `const theme = useTheme();` at the top of the component function, then replaces literals:

`src/ui/MessageList.tsx`:
- `color="blue"` (user) → `color={theme.user}`
- `color="cyan"` (tool) → `color={theme.accent}`
- `color="gray"` (notice, result) → `color={theme.muted}`
- `color="red"` (error) → `color={theme.error}`
- diff line: `color={l.sign === "+" ? theme.success : l.sign === "-" ? theme.removed : theme.muted}`

`src/ui/StatusBar.tsx`: `color="gray"` → `color={theme.muted}` (the `formatTokens`/`formatElapsed` helpers stay untouched).

`src/ui/WorkingIndicator.tsx`: `color="cyan"` → `color={theme.accent}`; inner `color="gray"` → `color={theme.muted}`.

`src/ui/SuggestionMenu.tsx`: `color={isSelected ? "cyan" : undefined}` → `color={isSelected ? theme.accent : undefined}`; `color="gray"` → `color={theme.muted}`.

`src/ui/ResumePicker.tsx`: `color="gray"` → `color={theme.muted}`; `color="yellow"` → `color={theme.warning}`. Note: the empty-entries early return also uses a color, so call `useTheme()` before that return.

`src/ui/PermissionDialog.tsx`: `borderColor="yellow"` → `borderColor={theme.warning}`; `color="yellow"` → `color={theme.warning}`.

`src/ui/InputBox.tsx`: `color="gray"` on the "working…" text → `color={theme.muted}`.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. If `tests/app.test.tsx` mocks `CommandContext` or asserts rendered output, add `setTheme`/`listThemes` mocks or adjust snapshots as needed — behavior must be identical under the default `dark` theme since it maps 1:1 to the old literals.

- [ ] **Step 5: Manual smoke check**

Run the TUI briefly (e.g. `npm run dev` or `node dist/index.js` per README), type `/theme` to see the list, `/theme mono` to switch, restart and confirm the choice persisted, then `/theme dark` to restore.

- [ ] **Step 6: Commit**

```bash
git add src/ui/ThemeContext.tsx src/ui/App.tsx src/ui/MessageList.tsx src/ui/StatusBar.tsx src/ui/WorkingIndicator.tsx src/ui/SuggestionMenu.tsx src/ui/ResumePicker.tsx src/ui/PermissionDialog.tsx src/ui/InputBox.tsx tests/app.test.tsx
git commit -m "feat: theme context and migrate UI colors to theme slots"
```
