# Command Autocompletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slash-command hint line with a selectable autocomplete menu that completes command names, command arguments, and `@file` paths.

**Architecture:** A pure completion engine (`getSuggestions`) with three providers checked in priority order (@file, argument, command-name), a `FileIndex` for cached project-file listing, a `SuggestionMenu` Ink component, and key-routing changes in `InputBox`.

**Tech Stack:** TypeScript, Ink (React for terminals), vitest. ESM imports use `.js` extensions.

## Global Constraints

- All code, comments, and identifiers in English only.
- Test environment is `node` (vitest); UI components are tested at the pure-function level, not rendered.
- Run tests with `npx vitest run <file>`.

---

### Task 1: Completion engine — command-name provider

**Files:**
- Create: `src/commands/completion.ts`
- Test: `tests/completion.test.ts`

**Interfaces:**
- Consumes: `Command` from `src/commands/types.ts` (has `name`, `description`).
- Produces (used by Tasks 2, 4, 6):

```ts
export interface Suggestion {
  value: string;        // text inserted on accept
  label: string;        // shown in the menu
  description?: string; // gray right-hand text
  replaceStart: number; // [replaceStart, replaceEnd) in the input is replaced by value
  replaceEnd: number;
}

export interface CompletionContext {
  registry: Map<string, Command>;
  providerNames(): string[];
  listFiles(): string[];      // project-relative paths, forward slashes
  refreshFiles?(): void;      // invalidate the file cache (Task 6 calls it)
}

export function getSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[];
export function applySuggestion(text: string, s: Suggestion): { text: string; cursor: number };
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/completion.test.ts
import { describe, it, expect } from "vitest";
import { getSuggestions, applySuggestion, type CompletionContext } from "../src/commands/completion.js";
import { buildRegistry } from "../src/commands/builtins.js";

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: buildRegistry(),
    providerNames: () => ["anthropic", "local"],
    listFiles: () => [],
    ...overrides
  };
}

describe("command-name provider", () => {
  it("suggests all commands for bare slash", () => {
    const s = getSuggestions("/", 1, ctx());
    expect(s.length).toBeGreaterThan(5);
    expect(s[0].label.startsWith("/")).toBe(true);
  });

  it("filters by prefix and includes description", () => {
    const s = getSuggestions("/pe", 3, ctx());
    expect(s.map(x => x.label)).toEqual(["/permissions"]);
    expect(s[0].description).toContain("Permission");
    expect(s[0]).toMatchObject({ replaceStart: 0, replaceEnd: 3, value: "/permissions " });
  });

  it("returns nothing for plain text or unknown prefix", () => {
    expect(getSuggestions("hello", 5, ctx())).toEqual([]);
    expect(getSuggestions("/zzz", 4, ctx())).toEqual([]);
  });

  it("returns nothing when cursor is not at the end of the slash token", () => {
    expect(getSuggestions("/pe", 1, ctx())).toEqual([]);
  });
});

describe("applySuggestion", () => {
  it("replaces the range and positions the cursor after the value", () => {
    const r = applySuggestion("/pe", { value: "/permissions ", label: "/permissions", replaceStart: 0, replaceEnd: 3 });
    expect(r).toEqual({ text: "/permissions ", cursor: 13 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/completion.test.ts`
Expected: FAIL — cannot resolve `../src/commands/completion.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/completion.ts
import type { Command } from "./types.js";

export interface Suggestion {
  value: string;
  label: string;
  description?: string;
  replaceStart: number;
  replaceEnd: number;
}

export interface CompletionContext {
  registry: Map<string, Command>;
  providerNames(): string[];
  listFiles(): string[];
  refreshFiles?(): void;
}

function commandNameSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  const m = /^\/(\w*)$/.exec(text);
  if (!m || cursor !== text.length) return [];
  return [...ctx.registry.values()]
    .filter(c => c.name.startsWith(m[1]))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({
      value: `/${c.name} `,
      label: `/${c.name}`,
      description: c.description,
      replaceStart: 0,
      replaceEnd: text.length
    }));
}

const PROVIDERS = [commandNameSuggestions];

export function getSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  for (const provider of PROVIDERS) {
    const result = provider(text, cursor, ctx);
    if (result.length > 0) return result;
  }
  return [];
}

export function applySuggestion(text: string, s: Suggestion): { text: string; cursor: number } {
  const next = text.slice(0, s.replaceStart) + s.value + text.slice(s.replaceEnd);
  return { text: next, cursor: s.replaceStart + s.value.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/completion.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/completion.ts tests/completion.test.ts
git commit -m "feat: completion engine with command-name provider"
```

---

### Task 2: Argument completion via `completeArgs`

**Files:**
- Modify: `src/commands/types.ts` (add `completeArgs` to `Command`)
- Modify: `src/commands/builtins.ts` (implement for `/permissions`, `/provider`)
- Modify: `src/commands/completion.ts` (argument provider)
- Test: `tests/completion.test.ts` (append)

**Interfaces:**
- Consumes: `Suggestion`, `CompletionContext`, `PROVIDERS` from Task 1.
- Produces: `Command.completeArgs?(prefix: string, ctx: CompletionContext): string[]` — later commands (e.g. future `/skills`, `/mcp`) implement this to get argument completion for free.

- [ ] **Step 1: Write the failing tests** (append to `tests/completion.test.ts`)

```ts
describe("argument provider", () => {
  it("suggests permission modes and subcommands", () => {
    const s = getSuggestions("/permissions ", 13, ctx());
    expect(s.map(x => x.value)).toEqual(["default", "acceptEdits", "bypassPermissions", "list", "clear"]);
    expect(s[0]).toMatchObject({ replaceStart: 13, replaceEnd: 13 });
  });

  it("filters argument suggestions by prefix", () => {
    const s = getSuggestions("/permissions cl", 15, ctx());
    expect(s.map(x => x.value)).toEqual(["clear"]);
    expect(s[0]).toMatchObject({ replaceStart: 13, replaceEnd: 15 });
  });

  it("suggests provider names for /provider", () => {
    const s = getSuggestions("/provider lo", 12, ctx());
    expect(s.map(x => x.value)).toEqual(["local"]);
  });

  it("returns nothing for commands without completeArgs", () => {
    expect(getSuggestions("/help x", 7, ctx())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/completion.test.ts`
Expected: the four new tests FAIL (empty arrays).

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to the `Command` interface (and import the type):

```ts
import type { CompletionContext } from "./completion.js";

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext, args: string): Promise<void>;
  completeArgs?(prefix: string, ctx: CompletionContext): string[];
}
```

(`completion.ts` imports `Command` from `types.ts`; a type-only import cycle is fine in TypeScript ESM.)

In `src/commands/builtins.ts`, add to the `/permissions` command object:

```ts
    completeArgs(prefix) {
      return [...MODES, "list", "clear"].filter(v => v.startsWith(prefix));
    }
```

and to the `/provider` command object:

```ts
    completeArgs(prefix, ctx) {
      return ctx.providerNames().filter(v => v.startsWith(prefix));
    }
```

In `src/commands/completion.ts`, add the provider and update `PROVIDERS` (argument and command-name providers never match the same input, since the command-name provider requires no space):

```ts
function argumentSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  const m = /^\/(\w+)\s+/.exec(text);
  if (!m || cursor !== text.length) return [];
  const cmd = ctx.registry.get(m[1]);
  if (!cmd?.completeArgs) return [];
  const argStart = m[0].length;
  const prefix = text.slice(argStart, cursor);
  return cmd.completeArgs(prefix, ctx).map(v => ({
    value: v,
    label: v,
    replaceStart: argStart,
    replaceEnd: cursor
  }));
}

const PROVIDERS = [argumentSuggestions, commandNameSuggestions];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/completion.test.ts tests/commands.test.ts`
Expected: PASS (existing command tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts src/commands/completion.ts tests/completion.test.ts
git commit -m "feat: argument completion via Command.completeArgs"
```

---

### Task 3: FileIndex — project file listing with fuzzy filter

**Files:**
- Create: `src/commands/fileIndex.ts`
- Test: `tests/fileIndex.test.ts`

**Interfaces:**
- Produces (used by Tasks 4 and 6):

```ts
export class FileIndex {
  constructor(root: string);
  list(): string[];   // cached relative paths, forward slashes
  refresh(): void;    // drop the cache
}
export function fuzzyFilter(paths: string[], token: string, limit?: number): string[]; // default limit 10
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/fileIndex.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex, fuzzyFilter } from "../src/commands/fileIndex.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-idx-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src", "cli.tsx"), "");
  writeFileSync(join(root, "src", "version.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, ".env"), "");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
  return root;
}

describe("FileIndex", () => {
  it("lists files recursively with forward slashes, skipping ignored dirs and dotfiles", () => {
    const idx = new FileIndex(fixture());
    const files = idx.list().sort();
    expect(files).toEqual(["README.md", "src/cli.tsx", "src/version.ts"]);
  });

  it("caches until refresh", () => {
    const root = fixture();
    const idx = new FileIndex(root);
    idx.list();
    writeFileSync(join(root, "new.txt"), "");
    expect(idx.list()).not.toContain("new.txt");
    idx.refresh();
    expect(idx.list()).toContain("new.txt");
  });

  it("returns empty for an unreadable root", () => {
    const idx = new FileIndex(join(tmpdir(), "definitely-missing-dir-xyz"));
    expect(idx.list()).toEqual([]);
  });
});

describe("fuzzyFilter", () => {
  const paths = ["src/cli.tsx", "src/ui/App.tsx", "tests/app.test.tsx", "README.md"];

  it("matches subsequences", () => {
    expect(fuzzyFilter(paths, "sct")).toContain("src/cli.tsx");
  });

  it("ranks basename prefix matches first", () => {
    expect(fuzzyFilter(paths, "app")[0]).toBe("src/ui/App.tsx");
  });

  it("empty token returns shortest paths first, capped", () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    expect(fuzzyFilter(many, "").length).toBe(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fileIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/commands/fileIndex.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED = new Set(["node_modules", "dist"]);
const MAX_ENTRIES = 5000;

export class FileIndex {
  private cache?: string[];

  constructor(private root: string) {}

  list(): string[] {
    if (!this.cache) this.cache = this.walk();
    return this.cache;
  }

  refresh(): void {
    this.cache = undefined;
  }

  private walk(): string[] {
    const out: string[] = [];
    const stack = [""];
    while (stack.length > 0 && out.length < MAX_ENTRIES) {
      const rel = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(join(this.root, rel), { withFileTypes: true });
      } catch {
        continue; // unreadable dir: skip silently
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) stack.push(childRel);
        else if (e.isFile()) out.push(childRel);
        if (out.length >= MAX_ENTRIES) break;
      }
    }
    return out;
  }
}

function isSubsequence(token: string, path: string): boolean {
  let i = 0;
  const lower = path.toLowerCase();
  for (const ch of token.toLowerCase()) {
    i = lower.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

export function fuzzyFilter(paths: string[], token: string, limit = 10): string[] {
  const basenamePrefix = (p: string) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    return base.startsWith(token.toLowerCase()) ? 0 : 1;
  };
  return paths
    .filter(p => isSubsequence(token, p))
    .sort((a, b) =>
      basenamePrefix(a) - basenamePrefix(b) ||
      a.length - b.length ||
      a.localeCompare(b)
    )
    .slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/fileIndex.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/fileIndex.ts tests/fileIndex.test.ts
git commit -m "feat: FileIndex with cached walk and fuzzy filter"
```

---

### Task 4: @file provider in the completion engine

**Files:**
- Modify: `src/commands/completion.ts`
- Test: `tests/completion.test.ts` (append)

**Interfaces:**
- Consumes: `fuzzyFilter` from Task 3; `ctx.listFiles()` from the `CompletionContext` of Task 1.
- Produces: @file suggestions with highest provider priority.

- [ ] **Step 1: Write the failing tests** (append to `tests/completion.test.ts`)

```ts
describe("@file provider", () => {
  const files = ["src/cli.tsx", "src/ui/App.tsx", "README.md"];

  it("suggests files for an @token before the cursor", () => {
    const s = getSuggestions("look at @cli", 12, ctx({ listFiles: () => files }));
    expect(s.map(x => x.value)).toEqual(["@src/cli.tsx"]);
    expect(s[0]).toMatchObject({ replaceStart: 8, replaceEnd: 12, label: "src/cli.tsx" });
  });

  it("works with @ at the start of input", () => {
    const s = getSuggestions("@READ", 5, ctx({ listFiles: () => files }));
    expect(s.map(x => x.value)).toEqual(["@README.md"]);
  });

  it("takes priority over the argument provider", () => {
    const s = getSuggestions("/model @cli", 11, ctx({ listFiles: () => files }));
    expect(s[0].value).toBe("@src/cli.tsx");
  });

  it("returns nothing when no files match or no @token", () => {
    expect(getSuggestions("@zzz", 4, ctx({ listFiles: () => files }))).toEqual([]);
    expect(getSuggestions("plain text", 10, ctx({ listFiles: () => files }))).toEqual([]);
  });

  it("ignores an @ that is part of an email-like word", () => {
    expect(getSuggestions("mail me a@b", 11, ctx({ listFiles: () => files }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/completion.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** — add to `src/commands/completion.ts`, importing `fuzzyFilter`:

```ts
import { fuzzyFilter } from "./fileIndex.js";

function fileSuggestions(text: string, cursor: number, ctx: CompletionContext): Suggestion[] {
  // @token immediately before the cursor; @ must be at start or after whitespace
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([\w./-]*)$/.exec(before);
  if (!m) return [];
  const atStart = m.index + m[1].length;
  return fuzzyFilter(ctx.listFiles(), m[2]).map(p => ({
    value: `@${p}`,
    label: p,
    replaceStart: atStart,
    replaceEnd: cursor
  }));
}

const PROVIDERS = [fileSuggestions, argumentSuggestions, commandNameSuggestions];
```

(Replace the previous `PROVIDERS` array.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/completion.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/commands/completion.ts tests/completion.test.ts
git commit -m "feat: @file path completion provider"
```

---

### Task 5: SuggestionMenu component

**Files:**
- Create: `src/ui/SuggestionMenu.tsx`
- Test: `tests/suggestionMenu.test.tsx`

**Interfaces:**
- Consumes: `Suggestion` from Task 1.
- Produces: `<SuggestionMenu suggestions={Suggestion[]} selected={number} />` and pure helper `visibleWindow(count: number, selected: number, max?: number): { start: number; end: number }` (default max 8).

- [ ] **Step 1: Write the failing test for the windowing helper**

```tsx
// tests/suggestionMenu.test.tsx
import { describe, it, expect } from "vitest";
import { visibleWindow } from "../src/ui/SuggestionMenu.js";

describe("visibleWindow", () => {
  it("shows everything when it fits", () => {
    expect(visibleWindow(5, 2)).toEqual({ start: 0, end: 5 });
  });

  it("scrolls to keep the selection visible", () => {
    expect(visibleWindow(20, 0)).toEqual({ start: 0, end: 8 });
    expect(visibleWindow(20, 10)).toEqual({ start: 3, end: 11 });
    expect(visibleWindow(20, 19)).toEqual({ start: 12, end: 20 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/suggestionMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/ui/SuggestionMenu.tsx
import React from "react";
import { Box, Text } from "ink";
import type { Suggestion } from "../commands/completion.js";

const MAX_ROWS = 8;

export function visibleWindow(count: number, selected: number, max = MAX_ROWS): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - max + 1), count - max);
  return { start, end: start + max };
}

interface Props {
  suggestions: Suggestion[];
  selected: number;
}

export function SuggestionMenu({ suggestions, selected }: Props) {
  const { start, end } = visibleWindow(suggestions.length, selected);
  const width = Math.max(...suggestions.map(s => s.label.length));
  return (
    <Box flexDirection="column">
      {suggestions.slice(start, end).map((s, i) => {
        const isSelected = start + i === selected;
        return (
          <Box key={s.label}>
            <Text color={isSelected ? "cyan" : undefined}>
              {isSelected ? "▶ " : "  "}{s.label.padEnd(width + 2)}
            </Text>
            {s.description && <Text color="gray">{s.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/suggestionMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SuggestionMenu.tsx tests/suggestionMenu.test.tsx
git commit -m "feat: SuggestionMenu component with scrolling window"
```

---

### Task 6: Wire the menu into InputBox and App

**Files:**
- Modify: `src/ui/InputBox.tsx` (menu state, key routing, render `SuggestionMenu`, drop old hint line and old tab logic)
- Modify: `src/ui/App.tsx` (build `CompletionContext` with a `FileIndex`, pass to `InputBox`)
- Test: `tests/inputBox.test.tsx` (existing tests must pass; menu logic is engine-tested)

**Interfaces:**
- Consumes: `getSuggestions`, `applySuggestion`, `CompletionContext` (Task 1), `FileIndex` (Task 3), `SuggestionMenu` (Task 5).
- Produces: `InputBox` props change: `registry` prop is replaced by `completionCtx: CompletionContext`. (`registry` was only used for completion; command dispatch happens in App.)

- [ ] **Step 1: Update InputBox**

Replace `src/ui/InputBox.tsx` with:

```tsx
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getSuggestions, applySuggestion, type CompletionContext } from "../commands/completion.js";
import { SuggestionMenu } from "./SuggestionMenu.js";
import type { History } from "../agent/history.js";

interface Props {
  completionCtx: CompletionContext;
  onSubmit(text: string): void;
  disabled: boolean;
  history: History;
}

export function InputBox({ completionCtx, onSubmit, disabled, history }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  // Terminals can deliver many keypresses in one stdin chunk (paste, fast
  // typing), so the handler may fire several times before React re-renders;
  // refs keep the authoritative state instead of a stale render closure.
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  // Draft saved when the user starts recalling history with the up arrow.
  const draftRef = useRef<string | undefined>(undefined);
  const suppressedRef = useRef(false);
  const selectedRef = useRef(0);
  const hadAtTokenRef = useRef(false);

  const currentSuggestions = () => {
    if (suppressedRef.current) return [];
    return getSuggestions(valueRef.current, cursorRef.current, completionCtx);
  };

  const update = (nextValue: string, nextCursor: number) => {
    const changed = nextValue !== valueRef.current;
    valueRef.current = nextValue;
    cursorRef.current = Math.max(0, Math.min(nextCursor, nextValue.length));
    if (changed) {
      suppressedRef.current = false;
      selectedRef.current = 0;
      // Refresh the file cache when a new @-completion session starts.
      const hasAt = /(^|\s)@[\w./-]*$/.test(nextValue.slice(0, cursorRef.current));
      if (hasAt && !hadAtTokenRef.current) completionCtx.refreshFiles?.();
      hadAtTokenRef.current = hasAt;
    }
    setValue(valueRef.current);
    setCursor(cursorRef.current);
    setSuppressed(suppressedRef.current);
    setSelected(selectedRef.current);
  };

  const submit = () => {
    const current = valueRef.current;
    if (current.endsWith("\\")) {
      // Line continuation: swap the trailing backslash for a newline.
      update(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    update("", 0);
    draftRef.current = undefined;
    history.resetCursor();
    if (text) {
      history.add(text);
      onSubmit(text);
    }
  };

  const accept = (suggestions: ReturnType<typeof currentSuggestions>) => {
    const s = suggestions[Math.min(selectedRef.current, suggestions.length - 1)];
    const r = applySuggestion(valueRef.current, s);
    update(r.text, r.cursor);
  };

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl || key.meta) return;
    const menu = currentSuggestions();
    const menuOpen = menu.length > 0;
    if (key.escape && menuOpen) {
      suppressedRef.current = true;
      setSuppressed(true);
      return;
    }
    if (key.leftArrow) {
      update(valueRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      update(valueRef.current, cursorRef.current + 1);
      return;
    }
    if (key.upArrow) {
      if (menuOpen) {
        selectedRef.current = (selectedRef.current - 1 + menu.length) % menu.length;
        setSelected(selectedRef.current);
        return;
      }
      if (draftRef.current === undefined) draftRef.current = valueRef.current;
      const recalled = history.back();
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
      if (menuOpen) {
        selectedRef.current = (selectedRef.current + 1) % menu.length;
        setSelected(selectedRef.current);
        return;
      }
      const recalled = history.forward();
      if (recalled !== undefined) {
        update(recalled, recalled.length);
      } else {
        update(draftRef.current ?? "", (draftRef.current ?? "").length);
        draftRef.current = undefined;
      }
      return;
    }
    if (key.backspace || key.delete) {
      const v = valueRef.current;
      const c = cursorRef.current;
      if (c > 0) update(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }
    if (key.tab) {
      if (menuOpen) accept(menu);
      return;
    }
    if (key.return && !input) {
      if (menuOpen) accept(menu);
      else submit();
      return;
    }
    // A chunk may mix text and line endings; split it so each line submits.
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        const m = currentSuggestions();
        if (m.length > 0) accept(m);
        else submit();
      } else if (ch >= " ") {
        const v = valueRef.current;
        const c = cursorRef.current;
        update(v.slice(0, c) + ch + v.slice(c), c + 1);
      }
    }
  });

  const suggestions = suppressed ? [] : getSuggestions(value, cursor, completionCtx);
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{before}{disabled ? "" : "█"}{after}</Text>
      </Box>
      {disabled && <Text color="gray">working… (Esc to interrupt)</Text>}
      {!disabled && suggestions.length > 0 && (
        <SuggestionMenu suggestions={suggestions} selected={Math.min(selected, suggestions.length - 1)} />
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Update App.tsx**

Add imports and a memoized context; replace the `<InputBox ...>` element. Around the existing imports:

```tsx
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
```

Inside the `App` component (near `permissionStoreRef` at `src/ui/App.tsx:52`):

```tsx
  const fileIndexRef = useRef(new FileIndex(props.cwd));
  const completionCtx: CompletionContext = {
    registry,
    providerNames: () => Object.keys(props.providers),
    listFiles: () => fileIndexRef.current.list(),
    refreshFiles: () => fileIndexRef.current.refresh()
  };
```

Replace the `InputBox` usage (currently `src/ui/App.tsx:252`):

```tsx
        <InputBox completionCtx={completionCtx} onSubmit={handleSubmit} disabled={phase === "streaming"} history={historyRef.current} />
```

- [ ] **Step 3: Fix compile fallout**

Run: `npx tsc --noEmit`
Expected: no errors. If `tests/inputBox.test.tsx` constructs `InputBox` with a `registry` prop, update it to pass `completionCtx` built the same way as in App (with `listFiles: () => []`). Remove the now-unused `completions` export from `src/commands/registry.ts` and its tests in `tests/commands.test.ts` if nothing else imports it (`parseSlash` stays).

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS, including the untouched history-recall and line-continuation tests in `tests/inputBox.test.tsx`.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`
Verify: typing `/` opens the menu; arrows move `▶`; Tab completes `/permissions ` then immediately shows mode suggestions; Enter accepts without submitting; Esc closes the menu; typing `@` then letters suggests project files; history recall (up arrow) still works when the menu is closed.

- [ ] **Step 6: Commit**

```bash
git add src/ui/InputBox.tsx src/ui/App.tsx src/commands/registry.ts tests/inputBox.test.tsx tests/commands.test.ts
git commit -m "feat: selectable autocomplete menu in InputBox"
```
