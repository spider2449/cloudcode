# Skill Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/skill install|update|remove|list` so users can install skill collections from GitHub repos as git clones under `~/.cloudcode/skill-repos/` and update them via `git pull`.

**Architecture:** A new `src/agent/skillRepos.ts` module owns URL normalization and git-backed repo management (install/update/remove/list) with an injectable git runner for tests. `src/agent/skills.ts` gains a recursive scanner and a fourth skill source that loads skills from every installed repo. A thin `/skill` builtin in `src/commands/builtins.ts` dispatches to the module and asks the app to reload skills via a new `reloadSkills()` on `CommandContext`.

**Tech Stack:** TypeScript (ESM, `node:` imports), vitest, `node:child_process` execFile for git.

## Global Constraints

- All code, comments, and messages in English only.
- Spec: `docs/superpowers/specs/2026-07-11-skill-repos-design.md`.
- Repo clones live at `<configDir()>/skill-repos/<owner>--<repo>/` (configDir from `src/agent/providers.ts`).
- Recursive scan depth limit: 5; skip `.git`, `node_modules`, and any directory starting with `.`.
- Precedence unchanged: user/claude/project skills and builtins beat repo skills on name collision.
- Run tests with `npx vitest run <file>`.

---

### Task 1: URL normalization

**Files:**
- Create: `src/agent/skillRepos.ts`
- Test: `tests/skillRepos.test.ts`

**Interfaces:**
- Produces: `normalizeRepoUrl(input: string): { ok: true; url: string; dirName: string } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/skillRepos.test.ts
import { describe, it, expect } from "vitest";
import { normalizeRepoUrl } from "../src/agent/skillRepos.js";

describe("normalizeRepoUrl", () => {
  it("accepts a full https GitHub URL", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("accepts a URL with .git suffix", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers.git")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("accepts owner/repo shorthand", () => {
    expect(normalizeRepoUrl("obra/superpowers")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("strips a trailing slash", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers/")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("rejects unsupported input", () => {
    const bad = ["", "not a url", "https://gitlab.com/a/b", "owner/repo/extra", "https://github.com/only-owner"];
    for (const input of bad) {
      const result = normalizeRepoUrl(input);
      expect(result.ok, input).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skillRepos.test.ts`
Expected: FAIL — cannot resolve `../src/agent/skillRepos.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/skillRepos.ts
export type NormalizedRepo =
  | { ok: true; url: string; dirName: string }
  | { ok: false; error: string };

const GITHUB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/;

export function normalizeRepoUrl(input: string): NormalizedRepo {
  const trimmed = input.trim();
  const match = GITHUB_URL.exec(trimmed) ?? SHORTHAND.exec(trimmed);
  if (!match) {
    return { ok: false, error: `Unsupported repo: "${input}". Use https://github.com/owner/repo or owner/repo.` };
  }
  const [, owner, repo] = match;
  return {
    ok: true,
    url: `https://github.com/${owner}/${repo}.git`,
    dirName: `${owner}--${repo}`
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skillRepos.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/skillRepos.ts tests/skillRepos.test.ts
git commit -m "feat: normalize GitHub repo URLs for skill repos"
```

---

### Task 2: Recursive repo skill scanning in loadSkills

**Files:**
- Modify: `src/agent/skills.ts`
- Test: `tests/skills.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `parseSkillFile` (private in skills.ts).
- Produces:
  - `Skill.source` type widens to `"user" | "claude" | "project" | \`repo:${string}\``
  - `scanRepoSkills(repoDir: string, repoName: string): Skill[]` (exported; recursive, depth 5, skips `.git`/`node_modules`/dot-dirs)
  - `loadSkills(cwd: string, userDir?: string, reposDir?: string): Skill[]` — new optional third param defaulting to `join(configDir(), "skill-repos")`; repo skills are added only when the name is not already taken (lowest precedence).

- [ ] **Step 1: Write the failing tests**

Append to `tests/skills.test.ts` (imports of `loadSkills` etc. already exist; add `scanRepoSkills` to the import):

```ts
describe("repo skills", () => {
  it("scanRepoSkills finds nested SKILL.md dirs and tags the source", () => {
    const repo = join(root, "repos", "obra--superpowers");
    writeSkill(join(repo, "skills"), "brainstorm", "---\nname: brainstorm\ndescription: Ideate\n---\nBody");
    writeSkill(join(repo, "plugins", "extra", "skills"), "deep", "---\nname: deep\n---\nDeep body");
    writeSkill(join(repo, ".git"), "ignored", "---\nname: ignored\n---\nno");
    writeSkill(join(repo, "node_modules", "x"), "ignored2", "---\nname: ignored2\n---\nno");
    const skills = scanRepoSkills(repo, "obra--superpowers");
    const names = skills.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["brainstorm", "deep"]);
    expect(skills[0].source).toBe("repo:obra--superpowers");
  });

  it("loadSkills includes repo skills with lowest precedence", () => {
    const cwd = join(root, "proj");
    const reposDir = join(root, "skill-repos");
    writeSkill(join(reposDir, "obra--superpowers", "skills"), "dup", "---\nname: dup\n---\nrepo version");
    writeSkill(join(reposDir, "obra--superpowers", "skills"), "solo", "---\nname: solo\n---\nrepo only");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, join(root, "nouser"), reposDir);
    const dup = skills.find(s => s.name === "dup")!;
    const solo = skills.find(s => s.name === "solo")!;
    expect(dup.content).toBe("project version");
    expect(solo.source).toBe("repo:obra--superpowers");
  });

  it("loadSkills tolerates a missing repos dir", () => {
    expect(loadSkills(join(root, "proj2"), join(root, "nouser"), join(root, "no-repos"))).toEqual([]);
  });
});
```

Note: add `scanRepoSkills` to the existing top-of-file import from `../src/agent/skills.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — `scanRepoSkills` is not exported

- [ ] **Step 3: Implement in src/agent/skills.ts**

Change the `Skill` interface source type:

```ts
export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "user" | "claude" | "project" | `repo:${string}`;
}
```

Add after `scanSkillDir`:

```ts
const SCAN_SKIP = new Set(["node_modules"]);
const MAX_REPO_DEPTH = 5;

export function scanRepoSkills(repoDir: string, repoName: string): Skill[] {
  const skills: Skill[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_REPO_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SCAN_SKIP.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      try {
        const parsed = parseSkillFile(readFileSync(join(sub, "SKILL.md"), "utf8"));
        if (parsed) {
          skills.push({
            name: parsed.name || entry.name,
            description: parsed.description,
            content: parsed.content,
            source: `repo:${repoName}`
          });
          continue; // a skill dir is a leaf
        }
      } catch {
        // no SKILL.md here: recurse
      }
      walk(sub, depth + 1);
    }
  };
  walk(repoDir, 0);
  return skills;
}
```

Replace `loadSkills`:

```ts
export function loadSkills(
  cwd: string,
  userDir: string = join(configDir(), "skills"),
  reposDir: string = join(configDir(), "skill-repos")
): Skill[] {
  const byName = new Map<string, Skill>();
  const scans: Skill[] = [
    ...scanSkillDir(userDir, "user"),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  for (const skill of scans) byName.set(skill.name, skill);
  let repoEntries;
  try {
    repoEntries = readdirSync(reposDir, { withFileTypes: true });
  } catch {
    repoEntries = [];
  }
  for (const entry of repoEntries) {
    if (!entry.isDirectory()) continue;
    for (const skill of scanRepoSkills(join(reposDir, entry.name), entry.name)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
```

- [ ] **Step 4: Run all skills tests**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS (all previous tests plus the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills.ts tests/skills.test.ts
git commit -m "feat: load skills from installed skill repos"
```

---

### Task 3: Git-backed repo management (install/update/remove/list)

**Files:**
- Modify: `src/agent/skillRepos.ts`
- Test: `tests/skillRepos.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeRepoUrl` (Task 1), `scanRepoSkills` from `../agent/skills.js` (Task 2), `configDir` from `./providers.js`.
- Produces:
  - `type GitRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; output: string }>`
  - `defaultGitRunner: GitRunner` (execFile-based; maps ENOENT to a "git executable not found on PATH" message)
  - `skillReposDir(): string` — `join(configDir(), "skill-repos")`
  - `listRepoNames(reposDir: string): string[]`
  - `installRepo(input: string, reposDir: string, git: GitRunner): Promise<string>` — returns a user-facing message
  - `updateRepos(name: string | undefined, reposDir: string, git: GitRunner): Promise<string>`
  - `removeRepo(name: string, reposDir: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/skillRepos.test.ts`:

```ts
import { beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installRepo, updateRepos, removeRepo, listRepoNames, type GitRunner } from "../src/agent/skillRepos.js";

let reposDir: string;

beforeEach(() => { reposDir = mkdtempSync(join(tmpdir(), "skill-repos-test-")); });
afterEach(() => { rmSync(reposDir, { recursive: true, force: true }); });

function fakeGit(result: { ok: boolean; output: string }, onCall?: (args: string[], cwd: string) => void): GitRunner {
  return async (args, cwd) => { onCall?.(args, cwd); return result; };
}

function fakeRepo(name: string, withSkill = true): void {
  const dir = join(reposDir, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (withSkill) {
    mkdirSync(join(dir, "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nBody");
  }
}

describe("installRepo", () => {
  it("clones and reports the skill count", async () => {
    let cloned: string[] = [];
    const git = fakeGit({ ok: true, output: "" }, args => {
      cloned = args;
      fakeRepo("obra--superpowers"); // simulate the clone creating the dir
    });
    const msg = await installRepo("obra/superpowers", reposDir, git);
    expect(cloned.slice(0, 3)).toEqual(["clone", "--depth", "1"]);
    expect(msg).toContain("1 skill");
  });

  it("warns when the repo has no skills", async () => {
    const git = fakeGit({ ok: true, output: "" }, () => fakeRepo("obra--empty", false));
    const msg = await installRepo("obra/empty", reposDir, git);
    expect(msg.toLowerCase()).toContain("no skill");
  });

  it("rejects an already-installed repo without calling git", async () => {
    fakeRepo("obra--superpowers");
    let called = false;
    const msg = await installRepo("obra/superpowers", reposDir, fakeGit({ ok: true, output: "" }, () => { called = true; }));
    expect(called).toBe(false);
    expect(msg).toContain("already installed");
  });

  it("surfaces git failure output", async () => {
    const msg = await installRepo("obra/superpowers", reposDir, fakeGit({ ok: false, output: "fatal: repository not found" }));
    expect(msg).toContain("fatal: repository not found");
  });

  it("rejects invalid input", async () => {
    const msg = await installRepo("nonsense", reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg).toContain("Unsupported repo");
  });
});

describe("updateRepos", () => {
  it("pulls a named repo", async () => {
    fakeRepo("obra--superpowers");
    const cwds: string[] = [];
    const msg = await updateRepos("obra--superpowers", reposDir, fakeGit({ ok: true, output: "Already up to date." }, (_a, cwd) => cwds.push(cwd)));
    expect(cwds).toEqual([join(reposDir, "obra--superpowers")]);
    expect(msg).toContain("Already up to date.");
  });

  it("pulls all repos when no name is given", async () => {
    fakeRepo("a--one");
    fakeRepo("b--two");
    const cwds: string[] = [];
    await updateRepos(undefined, reposDir, fakeGit({ ok: true, output: "ok" }, (_a, cwd) => cwds.push(cwd)));
    expect(cwds.sort()).toEqual([join(reposDir, "a--one"), join(reposDir, "b--two")]);
  });

  it("lists installed names for an unknown repo", async () => {
    fakeRepo("a--one");
    const msg = await updateRepos("nope", reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg).toContain("a--one");
  });

  it("reports when nothing is installed", async () => {
    const msg = await updateRepos(undefined, reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg.toLowerCase()).toContain("no skill repos");
  });
});

describe("removeRepo / listRepoNames", () => {
  it("removes an installed repo", () => {
    fakeRepo("a--one");
    const msg = removeRepo("a--one", reposDir);
    expect(existsSync(join(reposDir, "a--one"))).toBe(false);
    expect(msg).toContain("Removed");
  });

  it("lists installed names for an unknown repo", () => {
    fakeRepo("a--one");
    expect(removeRepo("nope", reposDir)).toContain("a--one");
  });

  it("listRepoNames returns directory names", () => {
    fakeRepo("a--one");
    fakeRepo("b--two");
    expect(listRepoNames(reposDir).sort()).toEqual(["a--one", "b--two"]);
    expect(listRepoNames(join(reposDir, "missing"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skillRepos.test.ts`
Expected: FAIL — `installRepo` etc. not exported

- [ ] **Step 3: Implement in src/agent/skillRepos.ts**

Append:

```ts
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";
import { scanRepoSkills } from "./skills.js";

export interface GitResult { ok: boolean; output: string; }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise(resolve => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ ok: false, output: "git executable not found on PATH. Install git to use /skill." });
        return;
      }
      resolve({ ok: !err, output: (stderr || stdout || "").trim() });
    });
  });

export function skillReposDir(): string {
  return join(configDir(), "skill-repos");
}

export function listRepoNames(reposDir: string): string[] {
  try {
    return readdirSync(reposDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function unknownRepoMessage(name: string, reposDir: string): string {
  const names = listRepoNames(reposDir);
  return names.length
    ? `Unknown skill repo: ${name}. Installed: ${names.join(", ")}`
    : `Unknown skill repo: ${name}. No skill repos installed.`;
}

export async function installRepo(input: string, reposDir: string, git: GitRunner): Promise<string> {
  const normalized = normalizeRepoUrl(input);
  if (!normalized.ok) return normalized.error;
  const target = join(reposDir, normalized.dirName);
  if (listRepoNames(reposDir).includes(normalized.dirName)) {
    return `${normalized.dirName} is already installed. Use /skill update ${normalized.dirName}.`;
  }
  mkdirSync(reposDir, { recursive: true });
  const result = await git(["clone", "--depth", "1", normalized.url, target], reposDir);
  if (!result.ok) return `Clone failed: ${result.output}`;
  const count = scanRepoSkills(target, normalized.dirName).length;
  return count > 0
    ? `Installed ${normalized.dirName} (${count} skill${count === 1 ? "" : "s"}).`
    : `Installed ${normalized.dirName}, but it contains no skills (no SKILL.md files found).`;
}

export async function updateRepos(
  name: string | undefined,
  reposDir: string,
  git: GitRunner
): Promise<string> {
  const installed = listRepoNames(reposDir);
  if (installed.length === 0) return "No skill repos installed. Use /skill install <github-url>.";
  if (name && !installed.includes(name)) return unknownRepoMessage(name, reposDir);
  const targets = name ? [name] : installed;
  const lines: string[] = [];
  for (const repo of targets) {
    const result = await git(["pull", "--ff-only"], join(reposDir, repo));
    lines.push(`${repo}: ${result.ok ? result.output || "updated" : `update failed: ${result.output}`}`);
  }
  return lines.join("\n");
}

export function removeRepo(name: string, reposDir: string): string {
  if (!listRepoNames(reposDir).includes(name)) return unknownRepoMessage(name, reposDir);
  rmSync(join(reposDir, name), { recursive: true, force: true });
  return `Removed ${name}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skillRepos.test.ts`
Expected: PASS (all Task 1 + Task 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/skillRepos.ts tests/skillRepos.test.ts
git commit -m "feat: install, update, remove skill repos via git"
```

---

### Task 4: /skill builtin command and skill reload wiring

**Files:**
- Modify: `src/commands/types.ts` (add `reloadSkills(): void` to `CommandContext`)
- Modify: `src/commands/builtins.ts` (add `/skill` command)
- Modify: `src/ui/App.tsx` (implement `reloadSkills` in the ctx object around line 264)
- Test: `tests/skillRepos.test.ts` already covers the logic; add a small command test in `tests/skillCommand.test.ts`

**Interfaces:**
- Consumes: `installRepo`, `updateRepos`, `removeRepo`, `listRepoNames`, `skillReposDir`, `defaultGitRunner` from `../agent/skillRepos.js` (Task 3); `scanRepoSkills` from `../agent/skills.js` (Task 2).
- Produces: builtin command `skill` with subcommands `install <url>`, `update [name]`, `remove <name> [--yes]`, `list`. Remove requires the user to re-run with `--yes` as the confirmation step.

- [ ] **Step 1: Write the failing test**

```ts
// tests/skillCommand.test.ts
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../src/commands/builtins.js";
import type { CommandContext } from "../src/commands/types.js";

function fakeCtx(notices: string[]): CommandContext {
  return {
    notice: t => notices.push(t),
    reloadSkills: () => notices.push("<reload>"),
    // remaining members are unused by /skill
  } as unknown as CommandContext;
}

describe("/skill command", () => {
  it("is registered with a description", () => {
    const cmd = buildRegistry().get("skill");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("install");
  });

  it("prints usage for a missing subcommand", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "");
    expect(notices[0]).toContain("Usage: /skill");
  });

  it("prints usage for an unknown subcommand", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "frobnicate");
    expect(notices[0]).toContain("Usage: /skill");
  });

  it("requires --yes before removing", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "remove some--repo");
    expect(notices[0]).toContain("--yes");
  });

  it("completes subcommand names", () => {
    const cmd = buildRegistry().get("skill")!;
    expect(cmd.completeArgs!("in", {} as never)).toEqual(["install"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/skillCommand.test.ts`
Expected: FAIL — `buildRegistry().get("skill")` is undefined

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to `CommandContext` after `listSkills(): string;`:

```ts
  reloadSkills(): void;
```

In `src/commands/builtins.ts`, add imports at the top:

```ts
import {
  installRepo, updateRepos, removeRepo, listRepoNames,
  skillReposDir, defaultGitRunner
} from "../agent/skillRepos.js";
import { scanRepoSkills } from "../agent/skills.js";
```

Add this command to the `commands` array (after the `skills` entry, keeping the list roughly alphabetical):

```ts
  {
    name: "skill",
    description: "Manage skill repos: /skill install <github-url> | update [name] | remove <name> --yes | list",
    async run(ctx, args) {
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const usage = "Usage: /skill install <github-url> | update [name] | remove <name> --yes | list";
      const reposDir = skillReposDir();
      switch (sub) {
        case "install": {
          if (!rest[0]) { ctx.notice(usage); return; }
          ctx.notice(await installRepo(rest[0], reposDir, defaultGitRunner));
          ctx.reloadSkills();
          return;
        }
        case "update": {
          ctx.notice(await updateRepos(rest[0], reposDir, defaultGitRunner));
          ctx.reloadSkills();
          return;
        }
        case "remove": {
          if (!rest[0]) { ctx.notice(usage); return; }
          if (rest[1] !== "--yes") {
            ctx.notice(`This deletes ${reposDir}\\${rest[0]}. Re-run: /skill remove ${rest[0]} --yes`);
            return;
          }
          ctx.notice(removeRepo(rest[0], reposDir));
          ctx.reloadSkills();
          return;
        }
        case "list": {
          const names = listRepoNames(reposDir);
          if (names.length === 0) {
            ctx.notice("No skill repos installed. Use /skill install <github-url>.\n\n" + ctx.listSkills());
            return;
          }
          const repoLines = names.map(name => {
            const skills = scanRepoSkills(join(reposDir, name), name);
            const skillNames = skills.map(s => `/${s.name}`).join(", ") || "(no skills)";
            return `${name}: ${skillNames}`;
          });
          ctx.notice(repoLines.join("\n") + "\n\nAll skills:\n" + ctx.listSkills());
          return;
        }
        default:
          ctx.notice(usage);
      }
    },
    completeArgs(prefix) {
      const parts = prefix.split(/\s+/);
      const subs = ["install", "update", "remove", "list"];
      if (parts.length <= 1) return subs.filter(s => s.startsWith(parts[0] ?? ""));
      const [sub, frag = ""] = parts;
      if (sub === "update" || sub === "remove") {
        return listRepoNames(skillReposDir())
          .filter(n => n.startsWith(frag))
          .map(n => `${sub} ${n}`);
      }
      return [];
    }
  },
```

Note: `join` is already imported in builtins.ts; the remove message uses `reposDir` with the platform separator — use `join(reposDir, rest[0])` in the message string instead of manual `\\` concatenation:

```ts
ctx.notice(`This deletes ${join(reposDir, rest[0])}. Re-run: /skill remove ${rest[0]} --yes`);
```

In `src/ui/App.tsx`, extract the two skill-loading lines (currently at lines 145-146 inside `createSession`) into a helper inside the component, and add `reloadSkills` to the command context object (near `listSkills` at line 264):

```ts
  function refreshSkills(): void {
    skillsRef.current = loadSkills(props.cwd);
    setRegistry(mergeSkillCommands(buildRegistry(), skillsRef.current));
  }
```

In `createSession`, replace lines 145-146 with `refreshSkills();`. In the ctx object, add:

```ts
    reloadSkills: () => refreshSkills(),
```

- [ ] **Step 4: Run all tests and typecheck**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all tests PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts src/ui/App.tsx tests/skillCommand.test.ts
git commit -m "feat: /skill builtin to install, update, remove, and list skill repos"
```

---

### Task 5: End-to-end verification

**Files:** none new — manual verification.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 2: Manual smoke test**

Build/launch cloudcode in a scratch project and run:
1. `/skill install obra/superpowers` — expect "Installed obra--superpowers (N skills)."
2. `/skills` — expect superpowers skills listed with source `repo:obra--superpowers`
3. `/skill list` — expect the repo and its skills listed
4. `/skill update` — expect "obra--superpowers: Already up to date." (or pull output)
5. `/skill remove obra--superpowers` — expect the `--yes` confirmation prompt
6. `/skill remove obra--superpowers --yes` — expect "Removed obra--superpowers." and the skills gone from `/skills`

- [ ] **Step 3: Commit any fixes discovered**

```bash
git add -A
git commit -m "fix: skill repo smoke-test fixes"
```
