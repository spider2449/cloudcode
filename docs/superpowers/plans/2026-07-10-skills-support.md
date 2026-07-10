# Skills Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover skills (directories with a `SKILL.md`) and register each as a slash command that sends the skill's instructions to the model, plus a `/skills` builtin that lists them.

**Architecture:** A pure loader `loadSkills` scans three directories (user, `.claude` compat, project — later wins on name conflict) and eagerly reads each `SKILL.md`. A pure helper merges skills into the command registry (builtins win). App loads skills at session creation and implements two new `CommandContext` methods: `sendPrompt` (same path as a normal input submit) and `listSkills`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Ink/React, vitest (node environment), Node `fs`/`path`.

## Global Constraints

- ALL code, comments, docs, and identifiers in English only.
- No new dependencies; frontmatter parsed with a minimal `key: value` line parser, not a YAML library.
- Discovery precedence (later wins): `~/.cloudcode/skills/` (user) → `<cwd>/.claude/skills/` (claude) → `<cwd>/.cloudcode/skills/` (project).
- Missing dirs, unreadable files, and files without a `---`-delimited frontmatter block contribute nothing — same tolerance as `loadProviders`/`loadMcpServers`.
- Skill name: frontmatter `name:`, falling back to the directory name; description falls back to `""`.
- Skill invocation prompt: `content` exactly, plus `"\n\nARGUMENTS: " + args` only when `args` is non-empty.
- Builtins win on name conflict with a skill.
- `/skills` empty message, verbatim: `No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/.`
- `/skills` list line format: `/<name>  <description>  (<source>)` (two spaces between fields), one line per skill.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Skill loader (`src/agent/skills.ts`)

**Files:**
- Create: `src/agent/skills.ts`
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.ts` (existing; returns `~/.cloudcode`).
- Produces:
  - `interface Skill { name: string; description: string; content: string; source: "user" | "claude" | "project"; }`
  - `loadSkills(cwd: string, userDir?: string): Skill[]` — `userDir` defaults to `join(configDir(), "skills")`.
  - `formatSkillList(skills: Skill[]): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/skills.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, formatSkillList } from "../src/agent/skills.js";

let root: string;

function writeSkill(base: string, dir: string, body: string): void {
  const skillDir = join(base, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("parses frontmatter name, description, and content", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "commit-helper",
      "---\nname: commit-helper\ndescription: Write a commit\n---\n\nDo the thing.\n");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{
      name: "commit-helper",
      description: "Write a commit",
      content: "Do the thing.",
      source: "project"
    }]);
  });

  it("falls back to directory name and empty description", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "my-skill", "---\n---\nInstructions.");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("");
    expect(skills[0].content).toBe("Instructions.");
  });

  it("skips files without a frontmatter block", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "plain", "Just markdown, no frontmatter.");
    expect(loadSkills(cwd, join(root, "nouser"))).toEqual([]);
  });

  it("returns empty for missing directories", () => {
    expect(loadSkills(join(root, "nope"), join(root, "nouser"))).toEqual([]);
  });

  it("project overrides claude overrides user on name conflict", () => {
    const cwd = join(root, "proj");
    const userDir = join(root, "user-skills");
    writeSkill(userDir, "dup", "---\nname: dup\n---\nuser version");
    writeSkill(join(cwd, ".claude", "skills"), "dup", "---\nname: dup\n---\nclaude version");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, userDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].content).toBe("project version");
    expect(skills[0].source).toBe("project");
  });

  it("claude skills load when no project skill shadows them", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".claude", "skills"), "cc-skill", "---\ndescription: from claude\n---\nBody");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{ name: "cc-skill", description: "from claude", content: "Body", source: "claude" }]);
  });
});

describe("formatSkillList", () => {
  it("formats one line per skill", () => {
    const out = formatSkillList([
      { name: "a", description: "does a", content: "", source: "project" },
      { name: "b", description: "does b", content: "", source: "user" }
    ]);
    expect(out).toBe("/a  does a  (project)\n/b  does b  (user)");
  });

  it("reports when no skills exist", () => {
    expect(formatSkillList([])).toBe(
      "No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/."
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — cannot resolve `../src/agent/skills.js`.

- [ ] **Step 3: Implement `src/agent/skills.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "user" | "claude" | "project";
}

interface ParsedSkillFile {
  name?: string;
  description: string;
  content: string;
}

function parseSkillFile(raw: string): ParsedSkillFile | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    content: match[2].trim()
  };
}

function scanSkillDir(dir: string, source: Skill["source"]): Skill[] {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
      const parsed = parseSkillFile(raw);
      if (parsed) {
        skills.push({
          name: parsed.name || entry.name,
          description: parsed.description,
          content: parsed.content,
          source
        });
      }
    } catch {
      // missing or unreadable SKILL.md: skip this directory
    }
  }
  return skills;
}

export function loadSkills(
  cwd: string,
  userDir: string = join(configDir(), "skills")
): Skill[] {
  const byName = new Map<string, Skill>();
  const scans: Skill[] = [
    ...scanSkillDir(userDir, "user"),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  for (const skill of scans) byName.set(skill.name, skill);
  return [...byName.values()];
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return "No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/.";
  }
  return skills.map(s => `/${s.name}  ${s.description}  (${s.source})`).join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/agent/skills.ts tests/skills.test.ts
git commit -m "feat: skill discovery from user, .claude, and project dirs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Skill commands and `/skills` builtin

**Files:**
- Create: `src/commands/skillCommands.ts`
- Modify: `src/commands/types.ts` (add `sendPrompt`, `listSkills` to `CommandContext`)
- Modify: `src/commands/builtins.ts` (add `/skills` builtin)
- Test: `tests/skillCommands.test.ts`
- Modify: `tests/commands.test.ts` (mockCtx gains `sendPrompt`/`listSkills`; registry list gains `"skills"`; `/skills` tests)

**Interfaces:**
- Consumes: `Skill` from `src/agent/skills.ts` (Task 1); `Command`, `CommandContext` from `src/commands/types.ts`.
- Produces:
  - `CommandContext.sendPrompt(text: string): void` and `CommandContext.listSkills(): string` (implemented by App in Task 3).
  - `buildSkillPrompt(skill: Skill, args: string): string`
  - `mergeSkillCommands(registry: Map<string, Command>, skills: Skill[]): Map<string, Command>` — returns a NEW map; existing (builtin) names are never overwritten.

- [ ] **Step 1: Extend `CommandContext` in `src/commands/types.ts`**

Add two members to the `CommandContext` interface (after `mcpStatus`):

```ts
  sendPrompt(text: string): void;
  listSkills(): string;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/skillCommands.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildSkillPrompt, mergeSkillCommands } from "../src/commands/skillCommands.js";
import { buildRegistry } from "../src/commands/builtins.js";
import type { Skill } from "../src/agent/skills.js";
import type { CommandContext } from "../src/commands/types.js";

const skill: Skill = { name: "commit-helper", description: "Write a commit", content: "Do the thing.", source: "project" };

describe("buildSkillPrompt", () => {
  it("returns content alone when args are empty", () => {
    expect(buildSkillPrompt(skill, "")).toBe("Do the thing.");
  });

  it("appends an ARGUMENTS line when args are non-empty", () => {
    expect(buildSkillPrompt(skill, "fix typo")).toBe("Do the thing.\n\nARGUMENTS: fix typo");
  });
});

describe("mergeSkillCommands", () => {
  it("registers a skill as a command that sends the built prompt", async () => {
    const merged = mergeSkillCommands(buildRegistry(), [skill]);
    const cmd = merged.get("commit-helper")!;
    expect(cmd.description).toBe("Write a commit");
    const ctx = { sendPrompt: vi.fn() } as unknown as CommandContext;
    await cmd.run(ctx, "fix typo");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("Do the thing.\n\nARGUMENTS: fix typo");
  });

  it("does not overwrite a builtin on name conflict", () => {
    const registry = buildRegistry();
    const helpBuiltin = registry.get("help")!;
    const merged = mergeSkillCommands(registry, [{ ...skill, name: "help" }]);
    expect(merged.get("help")).toBe(helpBuiltin);
  });

  it("does not mutate the input registry", () => {
    const registry = buildRegistry();
    const before = registry.size;
    mergeSkillCommands(registry, [skill]);
    expect(registry.size).toBe(before);
  });
});
```

In `tests/commands.test.ts`:
- Add to `mockCtx()` return object:

```ts
    sendPrompt: vi.fn(),
    listSkills: vi.fn().mockReturnValue("/a  does a  (project)")
```

- Update the "registers all v1 commands" expectation to:

```ts
    expect(names).toEqual(["clear", "cost", "exit", "help", "mcp", "model", "permissions", "provider", "resume", "skills"]);
```

- Add a describe block:

```ts
describe("/skills", () => {
  it("prints the skill list", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("skills")!.run(ctx, "");
    expect(ctx.listSkills).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("/a  does a  (project)");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/skillCommands.test.ts tests/commands.test.ts`
Expected: FAIL — cannot resolve `../src/commands/skillCommands.js`; registry list mismatch (no `skills`).

- [ ] **Step 4: Implement**

Create `src/commands/skillCommands.ts`:

```ts
import type { Command } from "./types.js";
import type { Skill } from "../agent/skills.js";

export function buildSkillPrompt(skill: Skill, args: string): string {
  return args ? `${skill.content}\n\nARGUMENTS: ${args}` : skill.content;
}

export function mergeSkillCommands(
  registry: Map<string, Command>,
  skills: Skill[]
): Map<string, Command> {
  const merged = new Map(registry);
  for (const skill of skills) {
    if (merged.has(skill.name)) continue;
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      async run(ctx, args) {
        ctx.sendPrompt(buildSkillPrompt(skill, args));
      }
    });
  }
  return merged;
}
```

In `src/commands/builtins.ts`, add to the `commands` array (after the `mcp` entry, before `exit`):

```ts
  {
    name: "skills",
    description: "List discovered skills",
    async run(ctx) { ctx.notice(ctx.listSkills()); }
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/skillCommands.test.ts tests/commands.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: one error in `src/ui/App.tsx` — its `ctx: CommandContext` object lacks the new `sendPrompt`/`listSkills` members. That is expected and is closed by Task 3. Do NOT modify App or add stubs in this task; verify it is the ONLY error, then report DONE_WITH_CONCERNS noting the known Task 3 typecheck gap. Any other error must be fixed.

```bash
git add src/commands/skillCommands.ts src/commands/types.ts src/commands/builtins.ts tests/skillCommands.test.ts tests/commands.test.ts
git commit -m "feat: skill slash commands and /skills builtin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: App wiring

**Files:**
- Modify: `src/ui/App.tsx`

**Interfaces:**
- Consumes: `loadSkills`, `formatSkillList`, `Skill` from `src/agent/skills.js` (Task 1); `mergeSkillCommands` from `src/commands/skillCommands.js` (Task 2).
- Produces: working `/skills` and skill commands in the TUI; `ctx.sendPrompt` and `ctx.listSkills` implementations.

- [ ] **Step 1: Modify `src/ui/App.tsx`**

Add imports:

```ts
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
```

Replace the static registry memo:

```ts
  const registry = useMemo(() => buildRegistry(), []);
```

with state plus a skills ref:

```ts
  const [registry, setRegistry] = useState(() => buildRegistry());
  const skillsRef = useRef<Skill[]>([]);
```

At the top of `createSession` (next to `loadMcpServers`), add:

```ts
    skillsRef.current = loadSkills(props.cwd);
    setRegistry(mergeSkillCommands(buildRegistry(), skillsRef.current));
```

Extract the non-slash body of `handleSubmit` into a helper and reuse it, so `handleSubmit` becomes:

```ts
  function sendUserMessage(text: string): void {
    if (!firstMessageRef.current) {
      firstMessageRef.current = text;
      if (sessionRef.current?.sessionId) recordSession(sessionRef.current.sessionId, providerName);
    }
    setItems(prev => [...prev, { kind: "user", text }]);
    setPhase("streaming");
    setWorkStartedAt(Date.now());
    sessionRef.current?.send(text);
  }

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = registry.get(slash.name);
      if (!cmd) { notice(`Unknown command: /${slash.name}`); return; }
      cmd.run(ctx, slash.args).catch(err => {
        setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      });
      return;
    }
    sendUserMessage(text);
  }
```

Add to the `ctx: CommandContext` object (after `mcpStatus`):

```ts
    sendPrompt: text => sendUserMessage(text),
    listSkills: () => formatSkillList(skillsRef.current),
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run`
Expected: all test files pass (previously 19 files / 108 tests; now 21 files, all passing).

- [ ] **Step 3: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: wire skill discovery and invocation into App

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
