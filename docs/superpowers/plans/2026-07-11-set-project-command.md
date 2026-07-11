# /set project Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/set project <path>` command (with a no-arg recent-projects picker) that switches cloudcode's working directory mid-run by remounting the app with a fresh session.

**Architecture:** A pure helper module (`projectPath.ts`) handles path resolution/validation and recent-project derivation. A new `set` builtin dispatches subcommands. `cli.tsx` gains a `Root` wrapper that owns `cwd` as React state and remounts `<App key={cwd}>` on switch; `App` exposes `switchProject`/`openProjectPicker` on `CommandContext` and renders a `ProjectPicker` (modeled on `ResumePicker`).

**Tech Stack:** TypeScript, React + Ink 5, vitest, ink-testing-library. Spec: `docs/superpowers/specs/2026-07-11-set-project-command-design.md`.

## Global Constraints

- All code, comments, names in English only.
- Node >= 18; ESM imports must use `.js` extensions.
- Follow existing patterns in `src/commands/builtins.ts` and `src/ui/ResumePicker.tsx`.
- Run tests with `npx vitest run <file>`.

---

### Task 1: Path resolution and recent-projects helpers

**Files:**
- Create: `src/commands/projectPath.ts`
- Test: `tests/projectPath.test.ts`

**Interfaces:**
- Consumes: `SessionEntry` from `src/agent/sessionIndex.ts` (`{ id, cwd, firstMessage, timestamp, provider }`).
- Produces:
  - `resolveProjectPath(input: string, cwd: string): { ok: true; path: string } | { ok: false; error: string }`
  - `recentProjects(entries: SessionEntry[], currentCwd: string): string[]` — distinct cwds, most recent first, current cwd included first.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/projectPath.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveProjectPath, recentProjects } from "../src/commands/projectPath.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";

function entry(cwd: string, timestamp: string): SessionEntry {
  return { id: cwd + timestamp, cwd, firstMessage: "hi", timestamp, provider: "anthropic" };
}

describe("resolveProjectPath", () => {
  const base = mkdtempSync(join(tmpdir(), "cloudcode-proj-"));

  it("resolves a relative path against cwd", () => {
    mkdirSync(join(base, "sub"));
    expect(resolveProjectPath("sub", base)).toEqual({ ok: true, path: resolve(base, "sub") });
  });

  it("accepts an absolute directory path", () => {
    expect(resolveProjectPath(base, "C:\\")).toEqual({ ok: true, path: resolve(base) });
  });

  it("expands ~ to the home directory", () => {
    const r = resolveProjectPath("~", base);
    expect(r).toEqual({ ok: true, path: resolve(homedir()) });
  });

  it("rejects a missing path", () => {
    const r = resolveProjectPath(join(base, "nope"), base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Not a directory");
  });

  it("rejects a file path", () => {
    const file = join(base, "file.txt");
    writeFileSync(file, "x");
    const r = resolveProjectPath(file, base);
    expect(r.ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(resolveProjectPath("", base).ok).toBe(false);
  });
});

describe("recentProjects", () => {
  it("dedupes cwds, most recent first, current cwd first", () => {
    const entries = [
      entry("/a", "2026-01-01T00:00:00Z"),
      entry("/b", "2026-01-03T00:00:00Z"),
      entry("/a", "2026-01-02T00:00:00Z"),
      entry("/cur", "2026-01-01T12:00:00Z")
    ];
    expect(recentProjects(entries, "/cur")).toEqual(["/cur", "/b", "/a"]);
  });

  it("includes current cwd even with no sessions", () => {
    expect(recentProjects([], "/cur")).toEqual(["/cur"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/projectPath.test.ts`
Expected: FAIL — cannot find module `src/commands/projectPath.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/commands/projectPath.ts
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SessionEntry } from "../agent/sessionIndex.js";

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string };

export function resolveProjectPath(input: string, cwd: string): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Usage: /set project <path>" };
  const expanded =
    trimmed === "~" ? homedir() :
    trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? resolve(homedir(), trimmed.slice(2)) :
    trimmed;
  const path = resolve(cwd, expanded);
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: `Not a directory: ${path}` };
  } catch {
    return { ok: false, error: `Not a directory: ${path}` };
  }
  return { ok: true, path };
}

export function recentProjects(entries: SessionEntry[], currentCwd: string): string[] {
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const cwds = [currentCwd, ...sorted.map(e => e.cwd)];
  return [...new Set(cwds)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/projectPath.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/projectPath.ts tests/projectPath.test.ts
git commit -m "feat: project path resolution and recent-project helpers"
```

---

### Task 2: /set builtin command with completion

**Files:**
- Modify: `src/commands/types.ts` (CommandContext)
- Modify: `src/commands/builtins.ts` (new `set` command)
- Test: `tests/commands.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveProjectPath` from Task 1.
- Produces: `CommandContext` gains:
  - `switchProject(path: string): void` — called with an already-validated absolute path.
  - `openProjectPicker(): void`
  - `currentCwd(): string`

- [ ] **Step 1: Write the failing tests**

Add to `tests/commands.test.ts`. Extend `mockCtx()` with the three new members:

```typescript
// inside mockCtx() return object, after listThemes:
    switchProject: vi.fn(),
    openProjectPicker: vi.fn(),
    currentCwd: vi.fn().mockReturnValue(process.cwd())
```

Update the registration test's expected name list to include `"set"` (keep it sorted):

```typescript
    expect(names).toEqual(["clear", "compact", "config", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "set", "skills", "theme"]);
```

Add a describe block:

```typescript
describe("/set", () => {
  it("no args prints usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("/set project"));
  });

  it("unknown subcommand prints usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "banana x");
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Unknown /set key: banana"));
  });

  it("project with no path opens the picker", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "project");
    expect(ctx.openProjectPicker).toHaveBeenCalled();
  });

  it("project with a valid path switches", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, `project ${process.cwd()}`);
    expect(ctx.switchProject).toHaveBeenCalledWith(process.cwd());
  });

  it("project with an invalid path notices and does not switch", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "project Z:\\definitely\\missing\\dir");
    expect(ctx.switchProject).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Not a directory"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — mockCtx type error / `set` not registered.

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to `CommandContext` after `listThemes(): string;`:

```typescript
  switchProject(path: string): void;
  openProjectPicker(): void;
  currentCwd(): string;
```

In `src/commands/builtins.ts`, add imports at the top:

```typescript
import { readdirSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { resolveProjectPath } from "./projectPath.js";
```

Add the command to the `commands` array (alphabetical position, after `resume`):

```typescript
  {
    name: "set",
    description: "Set session values: /set project [path] (no path: pick a recent project)",
    async run(ctx, args) {
      const [key, ...rest] = args.split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!key) { ctx.notice("Usage: /set project [path]"); return; }
      if (key !== "project") { ctx.notice(`Unknown /set key: ${key}. Keys: project`); return; }
      if (!value) { ctx.openProjectPicker(); return; }
      const result = resolveProjectPath(value, ctx.currentCwd());
      if (!result.ok) { ctx.notice(result.error); return; }
      ctx.switchProject(result.path);
    },
    completeArgs(prefix) {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) return ["project"].filter(k => k.startsWith(parts[0] ?? ""));
      if (parts[0] !== "project") return [];
      const typed = parts.slice(1).join(" ");
      const base = resolve(process.cwd(), typed || ".");
      // If the typed text doesn't end with a separator, complete within its parent.
      const endsWithSep = typed.endsWith("/") || typed.endsWith("\\") || typed === "";
      const dir = endsWithSep ? base : dirname(base);
      const frag = endsWithSep ? "" : basename(base).toLowerCase();
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.toLowerCase().startsWith(frag))
          .slice(0, 20)
          .map(d => `project ${join(endsWithSep ? typed : dirname(typed || "."), d.name)}`);
      } catch {
        return [];
      }
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS, including the 5 new `/set` tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts tests/commands.test.ts
git commit -m "feat: /set project builtin with path completion"
```

---

### Task 3: ProjectPicker component

**Files:**
- Create: `src/ui/ProjectPicker.tsx`
- Test: `tests/projectPicker.test.tsx`

**Interfaces:**
- Produces: `ProjectPicker({ projects, currentCwd, onPick, onCancel })` — `projects: string[]` (from `recentProjects`), `onPick(path: string)`, `onCancel()`. Picking the entry equal to `currentCwd` calls `onCancel()` instead of `onPick`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/projectPicker.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ProjectPicker } from "../src/ui/ProjectPicker.js";
import { ThemeProvider } from "../src/ui/ThemeContext.js";
import { THEMES } from "../src/ui/theme.js";

const wait = () => new Promise(r => setTimeout(r, 20));

function renderPicker(projects: string[], onPick = vi.fn(), onCancel = vi.fn()) {
  const utils = render(
    <ThemeProvider theme={THEMES.dark}>
      <ProjectPicker projects={projects} currentCwd="/cur" onPick={onPick} onCancel={onCancel} />
    </ThemeProvider>
  );
  return { ...utils, onPick, onCancel };
}

describe("ProjectPicker", () => {
  it("lists projects and marks the current one", () => {
    const { lastFrame } = renderPicker(["/cur", "/other"]);
    expect(lastFrame()).toContain("● /cur");
    expect(lastFrame()).toContain("/other");
  });

  it("picks a project with arrows and enter", async () => {
    const { stdin, onPick } = renderPicker(["/cur", "/other"]);
    await wait();
    stdin.write("[B"); // down arrow
    await wait();
    stdin.write("\r");
    await wait();
    expect(onPick).toHaveBeenCalledWith("/other");
  });

  it("selecting the current project cancels instead", async () => {
    const { stdin, onPick, onCancel } = renderPicker(["/cur", "/other"]);
    await wait();
    stdin.write("\r");
    await wait();
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("escape cancels", async () => {
    const { stdin, onCancel } = renderPicker(["/cur"]);
    await wait();
    stdin.write("");
    await wait();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/projectPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/ui/ProjectPicker.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./ThemeContext.js";

interface Props {
  projects: string[];
  currentCwd: string;
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ projects, currentCwd, onPick, onCancel }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(projects.length - 1, i + 1));
    else if (key.return && projects[index]) {
      if (projects[index] === currentCwd) onCancel();
      else onPick(projects[index]);
    }
  });

  if (projects.length === 0) {
    return <Text color={theme.muted}>No recent projects. Press Esc to close.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.warning}>Switch project (↑/↓, Enter, Esc)</Text>
      {projects.map((p, i) => (
        <Text key={p} inverse={i === index}>
          {p === currentCwd ? "● " : "  "}{p}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/projectPicker.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/ProjectPicker.tsx tests/projectPicker.test.tsx
git commit -m "feat: recent-project picker component"
```

---

### Task 4: Wire switch flow — App context + Root remount in cli.tsx

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/cli.tsx`
- Test: `tests/app.test.tsx` (extend)

**Interfaces:**
- Consumes: `recentProjects` (Task 1), `ProjectPicker` (Task 3), `CommandContext.switchProject/openProjectPicker/currentCwd` (Task 2).
- Produces: `AppProps` gains `onSwitchProject?: (path: string) => void`. `cli.tsx` renders a `Root` component owning `cwd` state and remounting `<App key={cwd}>`.

- [ ] **Step 1: Write the failing test**

Look at the top of `tests/app.test.tsx` for its existing `render(<App .../>)` helper/props pattern and reuse it exactly. Add a test:

```tsx
it("/set project <path> calls onSwitchProject with the resolved path", async () => {
  const onSwitchProject = vi.fn();
  // Render App with the file's usual props plus onSwitchProject={onSwitchProject}.
  const { stdin } = renderApp({ onSwitchProject }); // adapt to the file's helper
  await wait();
  stdin.write(`/set project ${process.cwd()}`);
  await wait();
  stdin.write("\r");
  await wait();
  expect(onSwitchProject).toHaveBeenCalledWith(process.cwd());
});
```

If `tests/app.test.tsx` has no reusable render helper, construct props inline the same way its first test does and add `onSwitchProject`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx`
Expected: FAIL — `onSwitchProject` not a prop / ctx missing members (type error at compile).

- [ ] **Step 3: Implement App.tsx changes**

Add imports:

```tsx
import { ProjectPicker } from "./ProjectPicker.js";
import { recentProjects } from "../commands/projectPath.js";
```

In `AppProps`, after `openResumeOnStart?: boolean;`:

```tsx
  onSwitchProject?: (path: string) => void;
```

Add state next to `showResumePicker`:

```tsx
const [showProjectPicker, setShowProjectPicker] = useState(false);
```

Add to the `ctx: CommandContext` object after `listThemes`:

```tsx
    // Do not dispose the session here: the remount's unmount cleanup
    // (useEffect return) disposes it, and if the switch fails in Root
    // (chdir error) the current session must stay alive.
    switchProject: path => {
      if (!props.onSwitchProject) { notice("Project switching is not available."); return; }
      props.onSwitchProject(path);
    },
    openProjectPicker: () => setShowProjectPicker(true),
    currentCwd: () => props.cwd,
```

Render the picker next to the `showResumePicker` block:

```tsx
        {showProjectPicker && (
          <ProjectPicker
            projects={recentProjects(props.sessionIndex.list(), props.cwd)}
            currentCwd={props.cwd}
            onPick={p => { setShowProjectPicker(false); ctx.switchProject(p); }}
            onCancel={() => setShowProjectPicker(false)}
          />
        )}
```

Hide the input box while the picker is open — change the InputBox condition to:

```tsx
        {!showResumePicker && !showProjectPicker && phase !== "permission" && (
```

- [ ] **Step 4: Implement cli.tsx Root wrapper**

Replace the bottom of `src/cli.tsx` (from `const cwd = process.cwd();` through the `render(...)` call) with:

```tsx
const initialCwd = process.cwd();
let resume: string | undefined;
if (values.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

function Root() {
  const [cwd, setCwd] = React.useState(initialCwd);
  const switchProject = (path: string) => {
    try {
      process.chdir(path);
    } catch (err) {
      console.error(`Failed to switch project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setCwd(path);
  };
  return (
    <App
      key={cwd}
      cwd={cwd}
      providers={providers}
      initialProvider={providerName}
      initialModel={settings.model}
      initialMode={settings.permissionMode}
      resume={cwd === initialCwd ? resume : undefined}
      sessionIndex={sessionIndex}
      openResumeOnStart={cwd === initialCwd ? values.resume : false}
      onSwitchProject={switchProject}
    />
  );
}

render(<Root />);
```

Note: per the spec, switching starts a fresh session (no auto-resume in the new directory); `resume` only applies to the initial cwd via `--continue`.

Also show a switch notice: in `App.tsx`, extend the initial `items` state so the welcome notice is followed by nothing extra — instead, the fresh mount itself is the signal; add `Switched project to <cwd>` by appending to the welcome notice only when this is not the first mount. Simplest concrete approach: pass the flag from Root —

In `AppProps` add:

```tsx
  switchedFrom?: string;
```

In Root, track it:

```tsx
  const [prevCwd, setPrevCwd] = React.useState<string | undefined>(undefined);
  const switchProject = (path: string) => {
    try {
      process.chdir(path);
    } catch (err) {
      console.error(`Failed to switch project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setPrevCwd(cwd);
    setCwd(path);
  };
```

and pass `switchedFrom={prevCwd}`. In `App.tsx`'s initial `items` state, after building `welcome`:

```tsx
    const initial: DisplayItem[] = welcome ? [{ kind: "notice", text: welcome }] : [];
    if (props.switchedFrom) initial.push({ kind: "notice", text: `Switched project to ${props.cwd}` });
    return initial;
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean; all tests PASS including the new app test.

- [ ] **Step 6: Manual verification**

Run: `npm run dev` in the repo, then `/set project ..`, confirm: status bar shows the new cwd, git segment updates, a fresh session/welcome renders with "Switched project to ...", and `/set project` (no arg) opens the picker with the previous directory listed.

- [ ] **Step 7: Commit**

```bash
git add src/ui/App.tsx src/cli.tsx tests/app.test.tsx
git commit -m "feat: wire /set project switch flow via app remount"
```
