# /memory + Auto-Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent auto-memory system (MEMORY.md index + typed memory files injected into the system prompt, background turn-end extraction) and a `/memory` command that edits memory files, to cloudcode.

**Architecture:** New `src/engine/memoryPaths.ts` (directory layout + path guard), `src/engine/memoryPrompt.ts` (prompt text + MEMORY.md truncation), `src/engine/extractMemories.ts` (turn-end side agent with memory-dir-restricted tools). `systemPrompt.ts` gains user-level CLAUDE.md and the memory section. `AgentSession` fires extraction after each turn. `/memory` opens a picker (mirroring ResumePicker) and launches `$EDITOR`.

**Tech Stack:** TypeScript ESM (`node:` imports, `.js` import suffixes), Ink (React) TUI, vitest.

## Global Constraints

- All code comments in English (user CLAUDE.md rule).
- Follow existing style: flat files, no new dependencies, `node:` prefixed imports, import paths end in `.js`.
- Config home is `configDir()` from `src/agent/providers.ts` (`~/.cloudcode`).
- Memory dir: `<configDir>/projects/<sanitized-cwd>/memory/`; index file `MEMORY.md`; caps 200 lines / 25 000 bytes.
- Memory types: `user`, `feedback`, `project`, `reference`.
- `autoMemoryEnabled` defaults to true when absent from settings.
- Run tests with `npx vitest run <file>` from repo root.
- Windows-safe paths everywhere (use `node:path`, never hardcode `/`).

---

### Task 1: Memory paths module

**Files:**
- Create: `src/engine/memoryPaths.ts`
- Test: `tests/memoryPaths.test.ts`

**Interfaces:**
- Produces: `sanitizePath(p: string): string`, `memoryDir(cwd: string, base?: string): string`, `memoryEntrypoint(cwd: string, base?: string): string`, `isInsideMemoryDir(candidate: string, dir: string): boolean`, `ensureMemoryDir(dir: string): boolean`. `base` defaults to `configDir()`; tests pass a temp base.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memoryPaths.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  sanitizePath, memoryDir, memoryEntrypoint, isInsideMemoryDir, ensureMemoryDir
} from "../src/engine/memoryPaths.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccmem-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("sanitizePath", () => {
  it("replaces separators, colons and unsafe chars with dashes", () => {
    expect(sanitizePath("C:\\Users\\me\\proj")).toBe("C--Users-me-proj");
    expect(sanitizePath("/home/me/proj")).toBe("-home-me-proj");
  });
});

describe("memoryDir / memoryEntrypoint", () => {
  it("builds <base>/projects/<sanitized-cwd>/memory", () => {
    const base = tmp();
    const dir = memoryDir("C:\\work\\app", base);
    expect(dir).toBe(join(base, "projects", "C--work-app", "memory"));
    expect(memoryEntrypoint("C:\\work\\app", base)).toBe(join(dir, "MEMORY.md"));
  });
});

describe("isInsideMemoryDir", () => {
  it("accepts files inside, rejects outside and traversal", () => {
    const dir = join(tmp(), "memory");
    expect(isInsideMemoryDir(join(dir, "note.md"), dir)).toBe(true);
    expect(isInsideMemoryDir(join(dir, "sub", "note.md"), dir)).toBe(true);
    expect(isInsideMemoryDir(join(dir, "..", "evil.md"), dir)).toBe(false);
    expect(isInsideMemoryDir(dir, dir)).toBe(false); // the dir itself is not a file inside it
  });
});

describe("ensureMemoryDir", () => {
  it("creates the directory recursively and is idempotent", () => {
    const dir = join(tmp(), "projects", "x", "memory");
    expect(ensureMemoryDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(ensureMemoryDir(dir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memoryPaths.test.ts`
Expected: FAIL — cannot resolve `../src/engine/memoryPaths.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/memoryPaths.ts
import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { configDir } from "../agent/providers.js";

// Turn an absolute project path into a stable directory-name-safe key.
export function sanitizePath(p: string): string {
  return p.replace(/[\\/:*?"<>|\s]/g, "-");
}

export function memoryDir(cwd: string, base: string = configDir()): string {
  return join(base, "projects", sanitizePath(cwd), "memory");
}

export function memoryEntrypoint(cwd: string, base: string = configDir()): string {
  return join(memoryDir(cwd, base), "MEMORY.md");
}

// True only for paths strictly inside the memory directory (not the dir itself).
// Resolves both sides first so ".." segments cannot escape.
export function isInsideMemoryDir(candidate: string, dir: string): boolean {
  const root = resolve(dir);
  const target = resolve(candidate);
  return target !== root && target.startsWith(root + sep);
}

// Create the memory directory (recursive, EEXIST-safe). Returns false on
// failure (e.g. permissions) so callers can skip the memory section.
export function ensureMemoryDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/memoryPaths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/memoryPaths.ts tests/memoryPaths.test.ts
git commit -m "feat(memory): add memory directory path helpers"
```

---

### Task 2: `autoMemoryEnabled` setting

**Files:**
- Modify: `src/agent/settings.ts`
- Modify: `src/commands/builtins.ts` (CONFIG_KEYS + configValue + switch + completion)
- Test: `tests/settings.test.ts` (append), `tests/commands.test.ts` (append)

**Interfaces:**
- Consumes: existing `Settings`, `loadSettings`, `saveSetting`.
- Produces: `Settings.autoMemoryEnabled?: boolean`; `saveSetting` accepts `string | boolean`; `/config autoMemory true|false`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings.test.ts`:

```ts
describe("autoMemoryEnabled", () => {
  it("round-trips booleans and ignores non-booleans", () => {
    const file = join(dir, "settings.json"); // reuse the suite's temp-dir pattern
    saveSetting("autoMemoryEnabled", false, file);
    expect(loadSettings(file).autoMemoryEnabled).toBe(false);
    saveSetting("autoMemoryEnabled", true, file);
    expect(loadSettings(file).autoMemoryEnabled).toBe(true);
    writeFileSync(file, JSON.stringify({ autoMemoryEnabled: "yes" }));
    expect(loadSettings(file).autoMemoryEnabled).toBeUndefined();
  });
});
```

(Adapt `dir`/imports to the existing test file's temp-dir helpers.)

Append to `tests/commands.test.ts`, following the file's existing fake-context pattern:

```ts
it("/config autoMemory sets the setting", async () => {
  const ctx = makeCtx(); // the file's existing fake CommandContext factory
  await registry.get("config")!.run(ctx, "autoMemory false");
  expect(ctx.notices.join("\n")).toContain("autoMemory = false");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts tests/commands.test.ts`
Expected: FAIL — `autoMemoryEnabled` undefined after save / unknown config key.

- [ ] **Step 3: Implement**

In `src/agent/settings.ts`:

```ts
export interface Settings {
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  theme?: string;
  autoMemoryEnabled?: boolean;
}
```

In `loadSettings`, after the theme line:

```ts
  if (typeof raw.autoMemoryEnabled === "boolean") out.autoMemoryEnabled = raw.autoMemoryEnabled;
```

Change `saveSetting` signature:

```ts
export function saveSetting(key: keyof Settings, value: string | boolean, filePath: string = DEFAULT_FILE()): void {
```

In `src/commands/builtins.ts`:

```ts
const CONFIG_KEYS = ["provider", "model", "permissionMode", "theme", "effort", "autoMemory"] as const;
```

In `configValue`:

```ts
  if (key === "autoMemory") return String(loadSettings().autoMemoryEnabled ?? true);
```

In the `/config` switch, add a case:

```ts
        case "autoMemory": {
          if (value !== "true" && value !== "false") {
            ctx.notice("Valid values: true, false");
            return;
          }
          saveSetting("autoMemoryEnabled", value === "true");
          break;
        }
```

In `/config`'s `completeArgs` value table, add:

```ts
        key === "autoMemory" ? ["true", "false"] :
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/settings.ts src/commands/builtins.ts tests/settings.test.ts tests/commands.test.ts
git commit -m "feat(memory): add autoMemoryEnabled setting and /config autoMemory"
```

---

### Task 3: Memory prompt builder + MEMORY.md truncation

**Files:**
- Create: `src/engine/memoryPrompt.ts`
- Test: `tests/memoryPrompt.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure functions).
- Produces: `truncateEntrypoint(raw: string): { content: string; wasTruncated: boolean }`, `buildMemoryPrompt(dir: string, entrypointContent: string): string`, and exported constants `MAX_ENTRYPOINT_LINES = 200`, `MAX_ENTRYPOINT_BYTES = 25_000`, `MEMORY_TYPES = ["user","feedback","project","reference"]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memoryPrompt.test.ts
import { describe, it, expect } from "vitest";
import {
  truncateEntrypoint, buildMemoryPrompt, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES
} from "../src/engine/memoryPrompt.js";

describe("truncateEntrypoint", () => {
  it("passes short content through untouched", () => {
    const r = truncateEntrypoint("- [A](a.md) — hook\n");
    expect(r.wasTruncated).toBe(false);
    expect(r.content).toBe("- [A](a.md) — hook");
  });
  it("truncates past the line cap with a warning", () => {
    const raw = Array.from({ length: 300 }, (_, i) => `- line ${i}`).join("\n");
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    const lines = r.content.split("\n");
    expect(lines.filter(l => l.startsWith("- line")).length).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.content).toContain("WARNING");
  });
  it("truncates past the byte cap at a newline boundary", () => {
    const raw = Array.from({ length: 150 }, () => "x".repeat(400)).join("\n"); // 150 lines, ~60KB
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    const body = r.content.slice(0, r.content.indexOf("\n\n> WARNING"));
    expect(body.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    expect(body.endsWith("x")).toBe(true); // cut at newline, not mid-line padding
  });
});

describe("buildMemoryPrompt", () => {
  it("contains the directory, taxonomy, protocol, and index content", () => {
    const p = buildMemoryPrompt("D:\\mem\\dir", "- [A](a.md) — hook");
    expect(p).toContain("D:\\mem\\dir");
    for (const t of ["user", "feedback", "project", "reference"]) expect(p).toContain(`**${t}**`);
    expect(p).toContain("What NOT to save");
    expect(p).toContain("MEMORY.md");
    expect(p).toContain("- [A](a.md) — hook");
  });
  it("notes an empty index", () => {
    expect(buildMemoryPrompt("D:\\mem\\dir", "")).toContain("currently empty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memoryPrompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/memoryPrompt.ts
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export function truncateEntrypoint(raw: string): { content: string; wasTruncated: boolean } {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const overLines = lines.length > MAX_ENTRYPOINT_LINES;
  const overBytes = trimmed.length > MAX_ENTRYPOINT_BYTES;
  if (!overLines && !overBytes) return { content: trimmed, wasTruncated: false };
  let out = overLines ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (out.length > MAX_ENTRYPOINT_BYTES) {
    const cut = out.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    out = out.slice(0, cut > 0 ? cut : MAX_ENTRYPOINT_BYTES);
  }
  const reason = overLines && overBytes
    ? `${lines.length} lines and ${trimmed.length} bytes`
    : overLines
      ? `${lines.length} lines (limit: ${MAX_ENTRYPOINT_LINES})`
      : `${trimmed.length} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) — index entries are too long`;
  return {
    content: out + `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~150 chars; move detail into topic files.`,
    wasTruncated: true
  };
}

export function buildMemoryPrompt(dir: string, entrypointContent: string): string {
  const index = entrypointContent.trim()
    ? truncateEntrypoint(entrypointContent).content
    : "Your MEMORY.md is currently empty. When you save new memories, they will appear here.";
  return `# Auto memory
You have a persistent, file-based memory system at \`${dir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

Build this memory up over time so future conversations know who the user is, how they like to collaborate, and the context behind the work. If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

## Types of memory
- **user** — the user's role, goals, expertise, and preferences. Save when you learn who they are; use it to tailor explanations and collaboration style.
- **feedback** — guidance on how to work: corrections ("stop doing X") AND confirmations ("perfect, keep doing that"). Record from failure and success. Include *why* so you can judge edge cases later.
- **project** — ongoing work, goals, deadlines, incidents, decisions and their rationale — anything not derivable from the code or git history. Convert relative dates to absolute when saving.
- **reference** — pointers to external systems (dashboards, issue trackers, Slack channels, URLs) and what they are for.

## What NOT to save
- Code patterns, conventions, architecture, file paths, project structure — derivable from the repo.
- Git history or who-changed-what — \`git log\`/\`git blame\` are authoritative.
- Debugging fix recipes — the fix is in the code.
- Anything already in CLAUDE.md.
- Ephemeral task state or current-conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save an activity log, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

## How to save memories
Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g. \`user_role.md\`, \`feedback_testing.md\`) with this frontmatter:

\`\`\`markdown
---
name: short-kebab-slug
description: one-line summary — used to decide relevance in future conversations, so be specific
type: ${MEMORY_TYPES.join(" | ")}
---

memory content — for feedback/project types: the rule/fact, then **Why:** and **How to apply:** lines
\`\`\`

**Step 2** — add a pointer line to \`MEMORY.md\`: \`- [Title](file.md) — one-line hook\` (under ~150 chars). MEMORY.md is an index, not a memory — never write memory content into it. It is always loaded into your context; lines after ${MAX_ENTRYPOINT_LINES} are truncated.

- Update or remove memories that turn out to be wrong or outdated.
- Do not write duplicates — check for an existing file to update first.

## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* memory: proceed as if MEMORY.md were empty — do not apply, cite, or mention memory content.
- Memories reflect what was true when written. Before acting on one, verify against the current state of files or resources; if it conflicts with what you observe now, trust the present and fix or remove the stale memory.

## Before recommending from memory
A memory that names a file, function, or flag is a claim it existed *when written*. Check the file exists or grep for the symbol before recommending it. "The memory says X exists" is not "X exists now."

## MEMORY.md

${index}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/memoryPrompt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/memoryPrompt.ts tests/memoryPrompt.test.ts
git commit -m "feat(memory): add memory prompt builder with MEMORY.md truncation"
```

---

### Task 4: System prompt integration (user CLAUDE.md + memory section)

**Files:**
- Modify: `src/engine/systemPrompt.ts`
- Test: `tests/engine-system-prompt.test.ts` (append)

**Interfaces:**
- Consumes: `memoryDir`, `memoryEntrypoint`, `ensureMemoryDir` (Task 1); `buildMemoryPrompt` (Task 3); `loadSettings` (Task 2).
- Produces: `buildSystemPrompt(cwd: string, opts?: { configBase?: string; autoMemory?: boolean }): string`. `opts` exists for tests; production callers pass only `cwd`. `autoMemory` defaults to `loadSettings().autoMemoryEnabled ?? true`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine-system-prompt.test.ts` (reuse its temp-dir pattern):

```ts
describe("user CLAUDE.md and memory section", () => {
  it("includes user-level CLAUDE.md from the config base", () => {
    const base = tmp();
    writeFileSync(join(base, "CLAUDE.md"), "always answer in haiku");
    const p = buildSystemPrompt(tmp(), { configBase: base });
    expect(p).toContain("# User instructions (CLAUDE.md)");
    expect(p).toContain("always answer in haiku");
  });
  it("includes the memory section with MEMORY.md content and creates the dir", () => {
    const base = tmp();
    const cwd = tmp();
    mkdirSync(join(base, "projects", sanitizePath(cwd), "memory"), { recursive: true });
    writeFileSync(join(base, "projects", sanitizePath(cwd), "memory", "MEMORY.md"), "- [A](a.md) — hook");
    const p = buildSystemPrompt(cwd, { configBase: base });
    expect(p).toContain("# Auto memory");
    expect(p).toContain("- [A](a.md) — hook");
  });
  it("omits the memory section when autoMemory is false", () => {
    const p = buildSystemPrompt(tmp(), { configBase: tmp(), autoMemory: false });
    expect(p).not.toContain("# Auto memory");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-system-prompt.test.ts`
Expected: FAIL — no second argument / missing sections.

- [ ] **Step 3: Implement**

Replace `src/engine/systemPrompt.ts` body:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../agent/skills.js";
import { loadSettings } from "../agent/settings.js";
import { configDir } from "../agent/providers.js";
import { memoryDir, memoryEntrypoint, ensureMemoryDir } from "./memoryPaths.js";
import { buildMemoryPrompt } from "./memoryPrompt.js";

const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. Working directory: `;

function readIfPresent(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

export interface SystemPromptOptions {
  configBase?: string;
  autoMemory?: boolean;
}

export function buildSystemPrompt(cwd: string, opts: SystemPromptOptions = {}): string {
  const base = opts.configBase ?? configDir();
  const autoMemory = opts.autoMemory ?? loadSettings().autoMemoryEnabled ?? true;
  let prompt = BASE + cwd;

  const userMd = readIfPresent(join(base, "CLAUDE.md"));
  if (userMd !== "") prompt += `\n\n# User instructions (CLAUDE.md)\n${userMd}`;

  const projectMd = readIfPresent(join(cwd, "CLAUDE.md"));
  if (projectMd !== "") prompt += `\n\n# Project instructions (CLAUDE.md)\n${projectMd}`;

  const skills = loadSkills(cwd);
  if (skills.length > 0) {
    const list = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    prompt += `\n\n# Available skills\nWhen a task matches a skill, follow that skill's instructions.\n${list}`;
  }

  if (autoMemory) {
    const dir = memoryDir(cwd, base);
    // Only advertise the memory system when the directory actually exists,
    // so the "already exists" promise in the prompt is truthful.
    if (ensureMemoryDir(dir)) {
      prompt += `\n\n${buildMemoryPrompt(dir, readIfPresent(memoryEntrypoint(cwd, base)))}`;
    }
  }
  return prompt;
}
```

- [ ] **Step 4: Run the full suite to catch regressions**

Run: `npx vitest run tests/engine-system-prompt.test.ts tests/session.test.ts tests/session-integration.test.ts`
Expected: PASS. If session tests hit the real `~/.cloudcode`, they may now include a memory section — update their assertions to match (assert on prefix/contains rather than full equality).

- [ ] **Step 5: Commit**

```bash
git add src/engine/systemPrompt.ts tests/engine-system-prompt.test.ts
git commit -m "feat(memory): inject user CLAUDE.md and auto-memory section into system prompt"
```

---

### Task 5: System prompt refresh plumbing

**Files:**
- Modify: `src/engine/loop.ts` (add `setSystemPrompt`)
- Modify: `src/agent/session.ts` (add `refreshSystemPrompt`)
- Test: `tests/engine-loop.test.ts` (append)

**Interfaces:**
- Consumes: `buildSystemPrompt(cwd)` (Task 4).
- Produces: `EngineLoop.setSystemPrompt(text: string): void`; `AgentSession.refreshSystemPrompt(): void` (rebuilds via `buildSystemPrompt(this.opts.cwd)`).

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-loop.test.ts` (reuse its fake-client pattern; the fake client records requests):

```ts
it("setSystemPrompt changes the system text sent on the next turn", async () => {
  const client = makeFakeClient(); // existing helper that captures req
  const loop = new EngineLoop({ ...baseOpts(client), systemPrompt: "old prompt" });
  loop.setSystemPrompt("new prompt");
  await loop.runTurn("hi", new AbortController().signal);
  const sys = client.lastRequest.system as Array<{ text: string }>;
  expect(sys[0].text).toBe("new prompt");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: FAIL — `setSystemPrompt` is not a function.

- [ ] **Step 3: Implement**

In `EngineLoop`, add a private field and setter (mirroring `setModel`):

```ts
  private systemPrompt: string;
  // in constructor:
  this.systemPrompt = opts.systemPrompt;

  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
  }
```

In `streamOnce`, change the request's system block to use the field:

```ts
      system: [{ type: "text" as const, text: this.systemPrompt, cache_control: { type: "ephemeral" as const } }],
```

In `AgentSession`:

```ts
  refreshSystemPrompt(): void {
    this.loop?.setSystemPrompt(buildSystemPrompt(this.opts.cwd));
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/engine-loop.test.ts tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts src/agent/session.ts tests/engine-loop.test.ts
git commit -m "feat(memory): allow refreshing the system prompt mid-session"
```

---

### Task 6: Background extraction agent

**Files:**
- Create: `src/engine/extractMemories.ts`
- Test: `tests/extractMemories.test.ts`

**Interfaces:**
- Consumes: `isInsideMemoryDir` (Task 1); `MessagesClient` (`src/engine/api.ts`); `readTool`, `writeTool`, `editTool` (`src/engine/tools/*`); `MEMORY_TYPES` (Task 3).
- Produces:
  - `countModelMessages(messages: unknown[], fromIndex: number): number`
  - `hasMemoryWrites(messages: unknown[], fromIndex: number, dir: string): boolean`
  - `formatTranscript(messages: unknown[], fromIndex: number): string`
  - `runExtraction(opts: { client: MessagesClient; model: string; memoryDir: string; messages: unknown[]; fromIndex: number }): Promise<boolean>` — returns true if any memory file was written.
  - `MIN_NEW_MESSAGES = 4`, `MAX_EXTRACT_TURNS = 4`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/extractMemories.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countModelMessages, hasMemoryWrites, formatTranscript, runExtraction
} from "../src/engine/extractMemories.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccext-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const user = (text: string) => ({ role: "user", content: text });
const asst = (blocks: unknown[]) => ({ role: "assistant", content: blocks });

describe("countModelMessages", () => {
  it("counts messages from the cursor", () => {
    const msgs = [user("a"), asst([{ type: "text", text: "b" }]), user("c")];
    expect(countModelMessages(msgs, 0)).toBe(3);
    expect(countModelMessages(msgs, 2)).toBe(1);
  });
});

describe("hasMemoryWrites", () => {
  it("detects Write/Edit tool_use into the memory dir after the cursor", () => {
    const dir = join(tmp(), "memory");
    const inside = asst([{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(dir, "a.md") } }]);
    const outside = asst([{ type: "tool_use", id: "2", name: "Write", input: { file_path: join(tmp(), "b.md") } }]);
    expect(hasMemoryWrites([inside], 0, dir)).toBe(true);
    expect(hasMemoryWrites([outside], 0, dir)).toBe(false);
    expect(hasMemoryWrites([inside], 1, dir)).toBe(false); // before cursor
  });
});

describe("formatTranscript", () => {
  it("renders roles, text, and tool names; skips tool_result bodies", () => {
    const msgs = [
      user("fix the bug"),
      asst([{ type: "text", text: "ok" }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "big output" }] }
    ];
    const t = formatTranscript(msgs, 0);
    expect(t).toContain("USER: fix the bug");
    expect(t).toContain("ASSISTANT: ok");
    expect(t).toContain("[tool: Bash]");
    expect(t).not.toContain("big output");
  });
});

describe("runExtraction", () => {
  // Minimal fake stream client: first call returns a Write tool_use into the
  // memory dir; second call returns plain text (ends the loop).
  function fakeClient(dir: string, calls: unknown[][]) {
    let n = 0;
    return {
      async *create(req: unknown, _signal: AbortSignal) {
        calls.push([req]);
        const first = n++ === 0;
        if (first) {
          yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
          yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: join(dir, "user_role.md"), content: "---\nname: user-role\ndescription: d\ntype: user\n---\nx" }) } };
          yield { type: "content_block_stop" };
          yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} };
        } else {
          yield { type: "content_block_start", content_block: { type: "text", text: "done" } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
        }
      }
    };
  }

  it("writes memory files via the guarded Write tool", async () => {
    const dir = join(tmp(), "memory");
    mkdirSync(dir, { recursive: true });
    const calls: unknown[][] = [];
    const wrote = await runExtraction({
      client: fakeClient(dir, calls) as never, model: "m", memoryDir: dir,
      messages: [user("I'm a data scientist"), asst([{ type: "text", text: "noted" }])], fromIndex: 0
    });
    expect(wrote).toBe(true);
    expect(readFileSync(join(dir, "user_role.md"), "utf8")).toContain("type: user");
  });

  it("rejects writes outside the memory dir", async () => {
    const dir = join(tmp(), "memory");
    mkdirSync(dir, { recursive: true });
    const evil = join(tmp(), "evil.md");
    const client = {
      async *create(_req: unknown, _s: AbortSignal) {
        yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
        yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: evil, content: "x" }) } };
        yield { type: "content_block_stop" };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
      }
    };
    const wrote = await runExtraction({
      client: client as never, model: "m", memoryDir: dir,
      messages: [user("hi")], fromIndex: 0
    });
    expect(wrote).toBe(false);
    expect(existsSync(evil)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extractMemories.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/extractMemories.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessagesClient } from "./api.js";
import type { ContentBlock } from "./messages.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { isInsideMemoryDir } from "./memoryPaths.js";
import { MEMORY_TYPES, MAX_ENTRYPOINT_LINES } from "./memoryPrompt.js";

export const MIN_NEW_MESSAGES = 4;
export const MAX_EXTRACT_TURNS = 4;
const MAX_TOKENS = 2048;

export function countModelMessages(messages: unknown[], fromIndex: number): number {
  return messages.slice(fromIndex).length;
}

// True when any assistant tool_use after the cursor wrote inside the memory
// dir — the main agent already saved memories, so extraction is redundant.
export function hasMemoryWrites(messages: unknown[], fromIndex: number, dir: string): boolean {
  for (const msg of messages.slice(fromIndex) as Array<{ role?: string; content?: unknown }>) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; input?: { file_path?: unknown } }>) {
      if (block.type !== "tool_use") continue;
      if (block.name !== "Write" && block.name !== "Edit") continue;
      const p = block.input?.file_path;
      if (typeof p === "string" && isInsideMemoryDir(p, dir)) return true;
    }
  }
  return false;
}

// Flatten recent conversation into plain text for the extraction prompt.
// Tool results are dropped (too large, rarely memory-relevant); tool calls
// are kept as one-line markers so the extractor sees what work happened.
export function formatTranscript(messages: unknown[], fromIndex: number): string {
  const out: string[] = [];
  for (const msg of messages.slice(fromIndex) as Array<{ role?: string; content?: unknown }>) {
    if (typeof msg.content === "string") {
      out.push(`${(msg.role ?? "user").toUpperCase()}: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; text?: string; name?: string }>) {
      if (block.type === "text" && block.text) out.push(`${(msg.role ?? "").toUpperCase()}: ${block.text}`);
      else if (block.type === "tool_use") out.push(`[tool: ${block.name}]`);
      // tool_result and thinking blocks are intentionally skipped
    }
  }
  return out.join("\n");
}

// One-line-per-file manifest of existing memories (frontmatter description).
function memoryManifest(dir: string): string {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".md") && f !== "MEMORY.md")
      .slice(0, 200)
      .map(f => {
        const head = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 10).join("\n");
        const desc = /description:\s*(.+)/.exec(head)?.[1] ?? "";
        return `- ${f}: ${desc}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

function extractionPrompt(dir: string, transcript: string, manifest: string): string {
  const existing = manifest
    ? `\n\n## Existing memory files\n${manifest}\nCheck this list before writing — update an existing file rather than creating a duplicate.`
    : "";
  return `You are a memory extraction agent. Analyze the conversation transcript below and save durable memories to \`${dir}\` using the Write/Edit tools (Read first when editing). Do not investigate anything beyond the transcript.

Memory types: ${MEMORY_TYPES.join(", ")}. Save only context NOT derivable from the repo (no code patterns, git history, fix recipes, or CLAUDE.md content; no ephemeral task state). If nothing is worth saving, reply with just "nothing to save".

Each memory is its own .md file with frontmatter (name, description, type). After writing a file, add one index line to \`${join(dir, "MEMORY.md")}\`: \`- [Title](file.md) — one-line hook\` (index only, max ${MAX_ENTRYPOINT_LINES} lines, never content).${existing}

## Transcript
${transcript}`;
}

interface ExtractionOptions {
  client: MessagesClient;
  model: string;
  memoryDir: string;
  messages: unknown[];
  fromIndex: number;
}

// Collect one non-streamed response from the events the client yields.
async function collectResponse(
  client: MessagesClient, req: Record<string, unknown>, signal: AbortSignal
): Promise<{ blocks: ContentBlock[]; stopReason: string | undefined }> {
  const blocks: ContentBlock[] = [];
  let pendingJson = "";
  let stopReason: string | undefined;
  const finalize = () => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "tool_use" && pendingJson.trim() !== "") {
      try { last.input = JSON.parse(pendingJson); } catch { last.input = {}; }
    }
    pendingJson = "";
  };
  for await (const event of client.create(req, signal)) {
    const e = event as { type?: string; content_block?: { type: string; text?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
    if (e.type === "content_block_start" && e.content_block) {
      finalize();
      const cb = e.content_block;
      if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
      else if (cb.type === "tool_use") blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
    } else if (e.type === "content_block_delta" && e.delta) {
      const last = blocks[blocks.length - 1];
      if (e.delta.type === "text_delta" && last?.type === "text") last.text += e.delta.text ?? "";
      else if (e.delta.type === "input_json_delta" && last?.type === "tool_use") pendingJson += e.delta.partial_json ?? "";
    } else if (e.type === "content_block_stop") {
      finalize();
    } else if (e.type === "message_delta" && e.delta) {
      stopReason = e.delta.stop_reason ?? stopReason;
    }
  }
  finalize();
  return { blocks, stopReason };
}

// Run the extraction mini-loop. Tools are restricted: Read anywhere,
// Write/Edit only inside the memory directory. Returns true if a file
// inside the memory dir was written or edited.
export async function runExtraction(opts: ExtractionOptions): Promise<boolean> {
  const { client, model, memoryDir: dir } = opts;
  const transcript = formatTranscript(opts.messages, opts.fromIndex);
  if (transcript.trim() === "") return false;
  const tools = [readTool, writeTool, editTool];
  const messages: unknown[] = [{ role: "user", content: extractionPrompt(dir, transcript, memoryManifest(dir)) }];
  const signal = new AbortController().signal;
  let wrote = false;
  for (let turn = 0; turn < MAX_EXTRACT_TURNS; turn++) {
    const { blocks, stopReason } = await collectResponse(client, {
      model,
      system: "You extract durable memories from agent conversations.",
      messages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: MAX_TOKENS
    }, signal);
    messages.push({ role: "assistant", content: blocks });
    if (stopReason !== "tool_use") break;
    const results = [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const tool = tools.find(t => t.name === block.name);
      const path = String((block.input as { file_path?: unknown }).file_path ?? "");
      const guarded = (block.name === "Write" || block.name === "Edit") && !isInsideMemoryDir(path, dir);
      if (!tool || guarded) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Denied: writes are only allowed inside the memory directory.", is_error: true });
        continue;
      }
      const out = await tool.execute(block.input, { cwd: dir });
      if ((block.name === "Write" || block.name === "Edit") && out.isError !== true) wrote = true;
      results.push({ type: "tool_result", tool_use_id: block.id, content: out.content, is_error: out.isError === true });
    }
    messages.push({ role: "user", content: results });
  }
  return wrote;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extractMemories.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/extractMemories.ts tests/extractMemories.test.ts
git commit -m "feat(memory): add background memory extraction agent"
```

---

### Task 7: Wire extraction into AgentSession

**Files:**
- Modify: `src/agent/session.ts`
- Test: `tests/session.test.ts` (append)

**Interfaces:**
- Consumes: `runExtraction`, `hasMemoryWrites`, `countModelMessages`, `MIN_NEW_MESSAGES` (Task 6); `memoryDir` (Task 1); `loadSettings` (Task 2); `refreshSystemPrompt` (Task 5).
- Produces: extraction fires after each `send()` turn completes; `AgentSessionOptions.onMemorySaved?: () => void` callback for the UI notice.

- [ ] **Step 1: Write the failing test**

Append to `tests/session.test.ts` (reuse its fake-client/session harness; if the harness doesn't exist, test the extracted helper method directly):

```ts
it("runs extraction after a turn and skips when the main agent wrote memories", async () => {
  // Use the exported decision helper so this stays a unit test:
  const dir = join(tmpBase, "projects", "x", "memory");
  const noWrites = [
    { role: "user", content: "I'm a data scientist" },
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "user", content: "thanks" },
    { role: "assistant", content: [{ type: "text", text: "np" }] }
  ];
  expect(shouldExtract(noWrites, 0, dir)).toBe(true);
  const withWrite = [
    ...noWrites.slice(0, 3),
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(dir, "a.md") } }] }
  ];
  expect(shouldExtract(withWrite, 0, dir)).toBe(false);
  expect(shouldExtract(noWrites, 2, dir)).toBe(false); // fewer than MIN_NEW_MESSAGES since cursor
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — `shouldExtract` not exported.

- [ ] **Step 3: Implement**

In `src/agent/session.ts`:

```ts
import { runExtraction, hasMemoryWrites, countModelMessages, MIN_NEW_MESSAGES } from "../engine/extractMemories.js";
import { memoryDir } from "../engine/memoryPaths.js";
import { loadSettings } from "./settings.js";

// Exported for tests: pure decision of whether extraction should run.
export function shouldExtract(messages: unknown[], fromIndex: number, dir: string): boolean {
  if (countModelMessages(messages, fromIndex) < MIN_NEW_MESSAGES) return false;
  return !hasMemoryWrites(messages, fromIndex, dir);
}
```

Add to `AgentSessionOptions`:

```ts
  onMemorySaved?(): void;
```

Add a private field to `AgentSession`:

```ts
  private extractCursor = 0;
```

Change `send()` to fire extraction after the turn completes:

```ts
  send(text: string): void {
    this.abortController = new AbortController();
    const before = this.loop?.messages.length ?? 0;
    void this.loop?.runTurn(text, this.abortController.signal).then(() => {
      const added = this.loop?.messages.slice(before) ?? [];
      for (const entry of added) this.sessionFile?.append(entry);
      this.maybeExtractMemories();
    });
  }

  private maybeExtractMemories(): void {
    if (loadSettings().autoMemoryEnabled === false) return;
    const messages = this.loop?.messages ?? [];
    const dir = memoryDir(this.opts.cwd);
    const from = this.extractCursor;
    // Advance the cursor unconditionally so a failing range is never retried.
    this.extractCursor = messages.length;
    if (!shouldExtract(messages, from, dir)) return;
    void runExtraction({
      client: makeClient(this.opts.provider),
      model: this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      memoryDir: dir,
      messages: [...messages],
      fromIndex: from
    }).then(wrote => {
      if (wrote) {
        this.refreshSystemPrompt();
        this.opts.onMemorySaved?.();
      }
    }).catch(() => { /* extraction is best-effort; never surface errors */ });
  }
```

In `src/ui/App.tsx`, where `new AgentSession({...})` is constructed, pass:

```ts
      onMemorySaved: () => notice("Memory updated."),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/session.test.ts tests/session-integration.test.ts tests/app.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts src/ui/App.tsx tests/session.test.ts
git commit -m "feat(memory): fire memory extraction at end of each turn"
```

---

### Task 8: /memory command, picker UI, and editor launch

**Files:**
- Create: `src/ui/MemoryPicker.tsx`
- Create: `src/commands/editor.ts`
- Modify: `src/commands/types.ts` (add `openMemoryPicker(): void` to `CommandContext`)
- Modify: `src/commands/builtins.ts` (add `/memory` command)
- Modify: `src/ui/App.tsx` (state, ctx method, render, pick handler)
- Test: `tests/memoryPicker.test.tsx`, `tests/commands.test.ts` (append)

**Interfaces:**
- Consumes: `memoryDir` (Task 1), `configDir()`, `refreshSystemPrompt` (Task 5), ResumePicker UI pattern, `notice`.
- Produces:
  - `buildMemoryOptions(cwd: string, base?: string): MemoryOption[]` where `MemoryOption = { label: string; path: string; kind: "file" | "folder" }` (exported from `MemoryPicker.tsx`).
  - `<MemoryPicker options onPick(option) onCancel />` Ink component.
  - `openInEditor(path: string): { ok: boolean; hint: string }` and `openFolder(path: string): void` in `src/commands/editor.ts`.
  - `/memory` command calling `ctx.openMemoryPicker()`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/memoryPicker.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryOptions } from "../src/ui/MemoryPicker.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccpick-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("buildMemoryOptions", () => {
  it("marks missing files (new) and includes the memory folder", () => {
    const base = tmp();
    const cwd = tmp();
    const opts = buildMemoryOptions(cwd, base);
    expect(opts[0]).toMatchObject({ label: "User memory (new)", path: join(base, "CLAUDE.md"), kind: "file" });
    expect(opts[1]).toMatchObject({ label: "Project memory (new)", path: join(cwd, "CLAUDE.md"), kind: "file" });
    expect(opts[2].kind).toBe("folder");
  });
  it("drops the (new) suffix for existing files", () => {
    const base = tmp();
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    const opts = buildMemoryOptions(cwd, base);
    expect(opts[1].label).toBe("Project memory");
  });
});
```

Append to `tests/commands.test.ts`:

```ts
it("/memory opens the memory picker", async () => {
  const ctx = makeCtx(); // extend the fake ctx with openMemoryPicker: () => { opened = true }
  await registry.get("memory")!.run(ctx, "");
  expect(ctx.memoryPickerOpened).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/memoryPicker.test.tsx tests/commands.test.ts`
Expected: FAIL — modules/command missing.

- [ ] **Step 3: Implement**

```tsx
// src/ui/MemoryPicker.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useTheme } from "./ThemeContext.js";
import { configDir } from "../agent/providers.js";
import { memoryDir } from "../engine/memoryPaths.js";

export interface MemoryOption {
  label: string;
  path: string;
  kind: "file" | "folder";
}

export function buildMemoryOptions(cwd: string, base: string = configDir()): MemoryOption[] {
  const userPath = join(base, "CLAUDE.md");
  const projectPath = join(cwd, "CLAUDE.md");
  const suffix = (p: string) => (existsSync(p) ? "" : " (new)");
  return [
    { label: `User memory${suffix(userPath)}`, path: userPath, kind: "file" },
    { label: `Project memory${suffix(projectPath)}`, path: projectPath, kind: "file" },
    { label: "Open auto-memory folder", path: memoryDir(cwd, base), kind: "folder" }
  ];
}

interface Props {
  options: MemoryOption[];
  onPick(option: MemoryOption): void;
  onCancel(): void;
}

export function MemoryPicker({ options, onPick, onCancel }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(options.length - 1, i + 1));
    else if (key.return && options[index]) onPick(options[index]);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.warning}>Memory (↑/↓, Enter, Esc)</Text>
      {options.map((o, i) => (
        <Text key={o.path} inverse={i === index}>{o.label}</Text>
      ))}
    </Box>
  );
}
```

```ts
// src/commands/editor.ts
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Create the file if missing without touching existing content (wx flag).
function ensureFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

// Open a file in the user's editor, blocking until it closes.
// Returns a hint describing which editor was used.
export function openInEditor(path: string): { ok: boolean; hint: string } {
  ensureFile(path);
  const editor = process.env.VISUAL || process.env.EDITOR
    || (process.platform === "win32" ? "notepad" : "nano");
  const source = process.env.VISUAL ? "$VISUAL" : process.env.EDITOR ? "$EDITOR" : "default";
  const result = spawnSync(editor, [path], { stdio: "inherit", shell: true });
  if (result.error) return { ok: false, hint: `Failed to launch ${editor}: ${result.error.message}` };
  return {
    ok: true,
    hint: source === "default"
      ? `Opened in ${editor}. Set $EDITOR or $VISUAL to use a different editor.`
      : `Opened with ${source}=${editor}.`
  };
}

// Open a folder in the platform file manager (fire-and-forget).
export function openFolder(path: string): void {
  const cmd = process.platform === "win32" ? "explorer"
    : process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(cmd, [path], { stdio: "ignore", shell: process.platform === "win32" });
}
```

In `src/commands/types.ts`, add to `CommandContext`:

```ts
  openMemoryPicker(): void;
```

In `src/commands/builtins.ts`, add to the `commands` array (alphabetical spot near `mcp`):

```ts
  {
    name: "memory",
    description: "Edit memory files (user/project CLAUDE.md, auto-memory folder)",
    async run(ctx) { ctx.openMemoryPicker(); }
  },
```

In `src/ui/App.tsx`:
1. Add state next to the other pickers: `const [showMemoryPicker, setShowMemoryPicker] = useState(false);`
2. In the `CommandContext` object (near `openResumePicker`): `openMemoryPicker: () => setShowMemoryPicker(true),`
3. Import `MemoryPicker, buildMemoryOptions` from `./MemoryPicker.js`, `openInEditor, openFolder` from `../commands/editor.js`, and `ensureMemoryDir` + `memoryDir` from `../engine/memoryPaths.js`.
4. Render next to `ResumePicker`/`ProjectPicker` (same conditional-overlay pattern used there):

```tsx
      {showMemoryPicker && (
        <MemoryPicker
          options={buildMemoryOptions(props.cwd)}
          onCancel={() => setShowMemoryPicker(false)}
          onPick={o => {
            setShowMemoryPicker(false);
            if (o.kind === "folder") {
              ensureMemoryDir(o.path);
              openFolder(o.path);
              notice(`Opened ${o.path}`);
              return;
            }
            const r = openInEditor(o.path);
            notice(r.hint);
            if (r.ok) sessionRef.current?.refreshSystemPrompt();
          }}
        />
      )}
```

Note: `openInEditor` blocks while a terminal editor runs; with `stdio: "inherit"` the editor takes over the terminal, and Ink repaints after it exits. GUI editors (notepad) return immediately after window close. If Ink's raw mode conflicts with a terminal editor on your platform, the follow-up is to pause/resume stdin around `spawnSync` — keep that out of scope unless tests show breakage.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/memoryPicker.test.tsx tests/commands.test.ts tests/app.test.tsx`
Expected: PASS. Then a manual smoke check: `npm run build` (or the repo's dev command) and `/memory` in a real terminal — picker opens, Enter on "Project memory" opens the editor, Esc cancels.

- [ ] **Step 5: Commit**

```bash
git add src/ui/MemoryPicker.tsx src/commands/editor.ts src/commands/types.ts src/commands/builtins.ts src/ui/App.tsx tests/memoryPicker.test.tsx tests/commands.test.ts
git commit -m "feat(memory): add /memory command with picker and editor launch"
```

---

### Task 9: Full-suite verification and docs

**Files:**
- Modify: `README.md` (commands table/section, if one exists)

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS. Fix any regressions (most likely: session tests asserting on exact system prompt text — loosen to `toContain`).

- [ ] **Step 2: Update README**

Add `/memory` to the commands list and a short "Memory" section: where memory lives (`~/.cloudcode/projects/<project>/memory/`), the `autoMemoryEnabled` setting, and that `~/.cloudcode/CLAUDE.md` is now loaded as user instructions.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document /memory command and auto-memory system"
```
