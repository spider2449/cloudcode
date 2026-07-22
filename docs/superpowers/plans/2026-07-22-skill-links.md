# Skill Repo Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the recursive skill-repo walk from every `loadSkills` call to install time, exposing repo skills as directory links under `<configDir>/skills/<repo>/<skill>`.

**Architecture:** Install/update creates junctions (Windows) or symlinks (POSIX) from `skills/<repoDirName>/<skillName>` to the skill's directory inside `skill-repos/`. Runtime discovery scans only skills dirs with a depth-2 scan (first-level dirs without `SKILL.md` are namespaces). A backfill in `loadSkills` links any repo that predates this change.

**Tech Stack:** Node.js (ESM, TypeScript), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-skill-links-design.md`

## Global Constraints

- All code, comments, names in English only.
- Links are created with `symlinkSync(targetDir, linkPath, "junction")` — junction on Windows (no admin needed), plain symlink on POSIX.
- Directory entries behind junctions/symlinks report `isSymbolicLink()`, **not** `isDirectory()`, from `readdirSync(..., { withFileTypes: true })`. Every scan that must see linked skills checks both.
- Precedence: project > claude > user > repo skills (repo skills only fill names not already taken).
- Test command: `npx vitest run tests/<file>` (full suite: `npm test`).

---

### Task 1: `linkRepoSkills` / `relinkRepoSkills` in skills.ts

**Files:**
- Modify: `src/agent/skills.ts` (refactor the walk in `scanRepoSkills`, add link functions)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: existing `parseSkillFile`, `SCAN_SKIP`, `MAX_REPO_DEPTH` in `src/agent/skills.ts`.
- Produces:
  - `export function linkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number` — scans the repo, creates `skillsDir/<repoName>/<skillName>` links, returns number of links created. Creates no namespace dir when the repo has no skills.
  - `export function relinkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number` — deletes `skillsDir/<repoName>` then calls `linkRepoSkills`.
  - `scanRepoSkills` keeps its current signature and behavior (removed later in Task 3).

- [ ] **Step 1: Write the failing tests**

Add to `tests/skills.test.ts` (new `describe` block; extend the existing imports from `../src/agent/skills.js` with `linkRepoSkills, relinkRepoSkills`, and add `existsSync, readFileSync, lstatSync` to the `node:fs` import):

```ts
describe("linkRepoSkills", () => {
  it("links each nested skill under skillsDir/<repo>/<skill>", () => {
    const repo = join(root, "skill-repos", "obra--superpowers");
    const skillsDir = join(root, "skills");
    writeSkill(join(repo, "skills"), "brainstorm", "---\nname: brainstorm\ndescription: Ideate\n---\nBody");
    writeSkill(join(repo, "plugins", "extra", "skills"), "deep", "---\nname: deep\n---\nDeep body");
    writeSkill(join(repo, ".git"), "ignored", "---\nname: ignored\n---\nno");
    const count = linkRepoSkills(repo, "obra--superpowers", skillsDir);
    expect(count).toBe(2);
    const link = join(skillsDir, "obra--superpowers", "brainstorm");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("Ideate");
    expect(existsSync(join(skillsDir, "obra--superpowers", "deep"))).toBe(true);
    expect(existsSync(join(skillsDir, "obra--superpowers", "ignored"))).toBe(false);
  });

  it("creates no namespace dir for a repo without skills", () => {
    const repo = join(root, "skill-repos", "obra--empty");
    mkdirSync(repo, { recursive: true });
    expect(linkRepoSkills(repo, "obra--empty", join(root, "skills"))).toBe(0);
    expect(existsSync(join(root, "skills", "obra--empty"))).toBe(false);
  });

  it("relinkRepoSkills drops links for skills that no longer exist", () => {
    const repo = join(root, "skill-repos", "r");
    const skillsDir = join(root, "skills");
    writeSkill(join(repo, "skills"), "old", "---\nname: old\n---\nBody");
    linkRepoSkills(repo, "r", skillsDir);
    rmSync(join(repo, "skills", "old"), { recursive: true, force: true });
    writeSkill(join(repo, "skills"), "new", "---\nname: new\n---\nBody");
    relinkRepoSkills(repo, "r", skillsDir);
    expect(existsSync(join(skillsDir, "r", "old"))).toBe(false);
    expect(existsSync(join(skillsDir, "r", "new"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — `linkRepoSkills` is not exported.

- [ ] **Step 3: Implement**

In `src/agent/skills.ts`, extend the `node:fs` import to:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, type Dirent } from "node:fs";
```

Replace `scanRepoSkills` with a shared walk plus the two new functions (keep `SCAN_SKIP` and `MAX_REPO_DEPTH` as-is):

```ts
interface RepoSkillDir { name: string; dir: string; parsed: ParsedSkillFile; }

function walkRepoSkills(repoDir: string): RepoSkillDir[] {
  const found: RepoSkillDir[] = [];
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
          found.push({ name: parsed.name || entry.name, dir: sub, parsed });
          continue; // a skill dir is a leaf
        }
      } catch {
        // no SKILL.md here: recurse
      }
      walk(sub, depth + 1);
    }
  };
  walk(repoDir, 0);
  return found;
}

export function scanRepoSkills(repoDir: string, repoName: string): Skill[] {
  return walkRepoSkills(repoDir).map(({ name, parsed }) => ({
    name,
    description: parsed.description,
    content: parsed.content,
    source: `repo:${repoName}` as const
  }));
}

export function linkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number {
  const found = walkRepoSkills(repoDir);
  if (found.length === 0) return 0;
  const nsDir = join(skillsDir, repoName);
  mkdirSync(nsDir, { recursive: true });
  let linked = 0;
  for (const { name, dir } of found) {
    const linkPath = join(nsDir, name);
    if (existsSync(linkPath)) continue; // duplicate skill name within the repo: first wins
    try {
      // "junction" on Windows (no admin rights needed); ignored on POSIX (plain symlink)
      symlinkSync(dir, linkPath, "junction");
      linked++;
    } catch {
      // link creation failed (exotic filesystem): skip; /skill update can retry
    }
  }
  return linked;
}

export function relinkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number {
  rmSync(join(skillsDir, repoName), { recursive: true, force: true });
  return linkRepoSkills(repoDir, repoName, skillsDir);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills.ts tests/skills.test.ts
git commit -m "feat(skills): add linkRepoSkills/relinkRepoSkills for install-time skill links"
```

---

### Task 2: Depth-2 discovery scan and backfill in `loadSkills`

**Files:**
- Modify: `src/agent/skills.ts` (`scanSkillDir`, `loadSkills`)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `linkRepoSkills` from Task 1.
- Produces: `loadSkills(cwd, userDir?, reposDir?)` — signature unchanged. New behavior: no recursive repo walk; depth-2 scan of skills dirs; skills under `skills/<sub>/` get source `` `repo:${sub}` `` when `<sub>` is a directory in `reposDir`; repos in `reposDir` without a `userDir/<repo>` dir are backfilled via `linkRepoSkills`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/skills.test.ts`, inside the existing `describe("repo skills", ...)` block:

```ts
  it("loadSkills backfills links for a repo installed before link-based discovery", () => {
    const reposDir = join(root, "skill-repos");
    const userDir = join(root, "user-skills");
    writeSkill(join(reposDir, "obra--superpowers", "skills"), "solo", "---\nname: solo\ndescription: s\n---\nrepo only");
    const skills = loadSkills(join(root, "proj"), userDir, reposDir);
    expect(skills.map(s => s.name)).toEqual(["solo"]);
    expect(skills[0].source).toBe("repo:obra--superpowers");
    expect(existsSync(join(userDir, "obra--superpowers", "solo"))).toBe(true);
  });

  it("loadSkills discovers namespaced links without walking the repo", () => {
    const reposDir = join(root, "skill-repos");
    const userDir = join(root, "user-skills");
    writeSkill(join(reposDir, "a--r", "skills"), "linked", "---\nname: linked\n---\nBody");
    linkRepoSkills(join(reposDir, "a--r"), "a--r", userDir);
    // a skill added to the repo AFTER linking is not discovered (no runtime walk)
    writeSkill(join(reposDir, "a--r", "skills"), "unlinked", "---\nname: unlinked\n---\nBody");
    const skills = loadSkills(join(root, "proj"), userDir, reposDir);
    expect(skills.map(s => s.name)).toEqual(["linked"]);
    expect(skills[0].source).toBe("repo:a--r");
  });

  it("namespaced dirs not matching a repo keep the base source", () => {
    const userDir = join(root, "user-skills");
    writeSkill(join(userDir, "my-group"), "grouped", "---\nname: grouped\n---\nBody");
    const skills = loadSkills(join(root, "proj"), userDir, join(root, "no-repos"));
    expect(skills).toEqual([{ name: "grouped", description: "", content: "Body", source: "user" }]);
  });

  it("does not scan deeper than two levels", () => {
    const userDir = join(root, "user-skills");
    writeSkill(join(userDir, "a", "b"), "too-deep", "---\nname: too-deep\n---\nBody");
    expect(loadSkills(join(root, "proj"), userDir, join(root, "no-repos"))).toEqual([]);
  });

  it("a local skill overrides a linked repo skill with the same name", () => {
    const reposDir = join(root, "skill-repos");
    const userDir = join(root, "user-skills");
    const cwd = join(root, "proj");
    writeSkill(join(reposDir, "a--r", "skills"), "dup", "---\nname: dup\n---\nrepo version");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, userDir, reposDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].content).toBe("project version");
    expect(skills[0].source).toBe("project");
  });
```

Also import `linkRepoSkills` (already imported in Task 1) and `existsSync` (already added in Task 1).

The pre-existing test `"loadSkills includes repo skills with lowest precedence"` must keep passing — backfill makes it work through links now.

**Delete** the pre-existing test `"scanRepoSkills finds nested SKILL.md dirs and tags the source"` and remove `scanRepoSkills` from the test file's imports (its walk behavior is now covered by the `linkRepoSkills` tests; the function itself is removed in Task 3).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — backfill test finds no skills, deep test may pass incidentally; at least the backfill, namespace, and no-runtime-walk assertions fail.

- [ ] **Step 3: Implement**

In `src/agent/skills.ts`, replace `scanSkillDir` and `loadSkills` with:

```ts
function isDirLike(entry: Dirent): boolean {
  // junctions and symlinks report isSymbolicLink(), not isDirectory()
  return entry.isDirectory() || entry.isSymbolicLink();
}

function readSkillAt(dir: string, fallbackName: string, source: Skill["source"]): Skill | undefined {
  let raw;
  try {
    raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined; // missing or unreadable SKILL.md
  }
  const parsed = parseSkillFile(raw);
  if (!parsed) return undefined;
  return { name: parsed.name || fallbackName, description: parsed.description, content: parsed.content, source };
}

function scanSkillDir(dir: string, source: Skill["source"], repoNames: ReadonlySet<string> = new Set()): Skill[] {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!isDirLike(entry)) continue;
    const sub = join(dir, entry.name);
    const skill = readSkillAt(sub, entry.name, source);
    if (skill) {
      skills.push(skill);
      continue;
    }
    // no SKILL.md: treat as a namespace dir and scan one level deeper
    const nestedSource = repoNames.has(entry.name) ? (`repo:${entry.name}` as const) : source;
    let children;
    try {
      children = readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!isDirLike(child)) continue;
      const nested = readSkillAt(join(sub, child.name), child.name, nestedSource);
      if (nested) skills.push(nested);
    }
  }
  return skills;
}

export function loadSkills(
  cwd: string,
  userDir: string = join(configDir(), "skills"),
  reposDir: string = join(configDir(), "skill-repos")
): Skill[] {
  let repoEntries: Dirent[];
  try {
    repoEntries = readdirSync(reposDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    repoEntries = [];
  }
  const repoNames = new Set(repoEntries.map(e => e.name));
  // backfill: repos installed before link-based discovery have no namespace dir yet
  for (const name of repoNames) {
    if (!existsSync(join(userDir, name))) linkRepoSkills(join(reposDir, name), name, userDir);
  }
  const scans: Skill[] = [
    ...scanSkillDir(userDir, "user", repoNames),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  const byName = new Map<string, Skill>();
  for (const skill of scans) {
    if (!skill.source.startsWith("repo:")) byName.set(skill.name, skill);
  }
  // repo skills have lowest precedence: only fill names no local skill claimed
  for (const skill of scans) {
    if (skill.source.startsWith("repo:") && !byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills.ts tests/skills.test.ts
git commit -m "feat(skills): discover repo skills via links; drop runtime repo walk"
```

---

### Task 3: Wire linking into install/update/remove

**Files:**
- Modify: `src/agent/skillRepos.ts`
- Modify: `src/commands/builtins.ts:329-349`
- Modify: `src/agent/skills.ts` (remove now-dead `scanRepoSkills`)
- Test: `tests/skillRepos.test.ts`

**Interfaces:**
- Consumes: `linkRepoSkills`, `relinkRepoSkills` from `src/agent/skills.ts` (Task 1).
- Produces:
  - `export function userSkillsDir(): string` — `join(configDir(), "skills")`.
  - `installRepo(input: string, reposDir: string, skillsDir: string, git: GitRunner): Promise<string>`
  - `updateRepos(name: string | undefined, reposDir: string, skillsDir: string, git: GitRunner): Promise<string>`
  - `removeRepo(name: string, reposDir: string, skillsDir: string): string`

- [ ] **Step 1: Update the tests (they define the new signatures)**

In `tests/skillRepos.test.ts`:

Replace the fixture setup block (lines 44-47) with:

```ts
let root: string;
let reposDir: string;
let skillsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-repos-test-"));
  reposDir = join(root, "skill-repos");
  skillsDir = join(root, "skills");
  mkdirSync(reposDir, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
```

Thread `skillsDir` through every existing call: `installRepo(x, reposDir, skillsDir, git)`, `updateRepos(x, reposDir, skillsDir, git)`, `removeRepo(x, reposDir, skillsDir)`.

Add these tests:

```ts
describe("skill links", () => {
  it("installRepo links skills into skillsDir/<repo>/", async () => {
    const git = fakeGit({ ok: true, output: "" }, () => fakeRepo("obra--superpowers"));
    const msg = await installRepo("obra/superpowers", reposDir, skillsDir, git);
    expect(msg).toContain("1 skill");
    expect(existsSync(join(skillsDir, "obra--superpowers", "demo"))).toBe(true);
  });

  it("updateRepos relinks after pull", async () => {
    fakeRepo("obra--superpowers");
    // stale link from a previous install
    mkdirSync(join(skillsDir, "obra--superpowers", "gone"), { recursive: true });
    await updateRepos("obra--superpowers", reposDir, skillsDir, fakeGit({ ok: true, output: "ok" }));
    expect(existsSync(join(skillsDir, "obra--superpowers", "gone"))).toBe(false);
    expect(existsSync(join(skillsDir, "obra--superpowers", "demo"))).toBe(true);
  });

  it("removeRepo removes the namespace dir too", () => {
    fakeRepo("a--one");
    mkdirSync(join(skillsDir, "a--one"), { recursive: true });
    removeRepo("a--one", reposDir, skillsDir);
    expect(existsSync(join(reposDir, "a--one"))).toBe(false);
    expect(existsSync(join(skillsDir, "a--one"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skillRepos.test.ts`
Expected: FAIL — signatures don't accept `skillsDir` (TypeScript/argument errors).

- [ ] **Step 3: Implement**

In `src/agent/skillRepos.ts`:

Change the import from skills.js:

```ts
import { linkRepoSkills, relinkRepoSkills } from "./skills.js";
```

Add below `skillReposDir`:

```ts
export function userSkillsDir(): string {
  return join(configDir(), "skills");
}
```

Update `installRepo` (new param, link instead of scan):

```ts
export async function installRepo(input: string, reposDir: string, skillsDir: string, git: GitRunner): Promise<string> {
  const normalized = normalizeRepoUrl(input);
  if (!normalized.ok) return normalized.error;
  const target = join(reposDir, normalized.dirName);
  if (listRepoNames(reposDir).includes(normalized.dirName)) {
    return `${normalized.dirName} is already installed. Use /skill update ${normalized.dirName}.`;
  }
  mkdirSync(reposDir, { recursive: true });
  const result = await git(["clone", "--depth", "1", normalized.url, target], reposDir);
  if (!result.ok) return `Clone failed: ${result.output}`;
  const count = linkRepoSkills(target, normalized.dirName, skillsDir);
  return count > 0
    ? `Installed ${normalized.dirName} (${count} skill${count === 1 ? "" : "s"}).`
    : `Installed ${normalized.dirName}, but it contains no skills (no SKILL.md files found).`;
}
```

Update `updateRepos` (new param, relink after successful pull):

```ts
export async function updateRepos(
  name: string | undefined,
  reposDir: string,
  skillsDir: string,
  git: GitRunner
): Promise<string> {
  const installed = listRepoNames(reposDir);
  if (installed.length === 0) return "No skill repos installed. Use /skill install <github-url>.";
  if (name && !installed.includes(name)) return unknownRepoMessage(name, reposDir);
  const targets = name ? [name] : installed;
  const lines: string[] = [];
  for (const repo of targets) {
    const result = await git(["pull", "--ff-only"], join(reposDir, repo));
    if (result.ok) relinkRepoSkills(join(reposDir, repo), repo, skillsDir);
    lines.push(`${repo}: ${result.ok ? result.output || "updated" : `update failed: ${result.output}`}`);
  }
  return lines.join("\n");
}
```

Update `removeRepo`:

```ts
export function removeRepo(name: string, reposDir: string, skillsDir: string): string {
  if (!listRepoNames(reposDir).includes(name)) return unknownRepoMessage(name, reposDir);
  rmSync(join(reposDir, name), { recursive: true, force: true });
  rmSync(join(skillsDir, name), { recursive: true, force: true });
  return `Removed ${name}.`;
}
```

In `src/commands/builtins.ts`: add `userSkillsDir` to the import from `../agent/skillRepos.js` (lines 10-11), then in the `/skill` handler (around line 329) add `const skillsDir = userSkillsDir();` next to `const reposDir = skillReposDir();` and pass it: `installRepo(rest[0], reposDir, skillsDir, defaultGitRunner)`, `updateRepos(rest[0], reposDir, skillsDir, defaultGitRunner)`, `removeRepo(rest[0], reposDir, skillsDir)`.

In `src/agent/skills.ts`: delete the now-unused `scanRepoSkills` export (keep `walkRepoSkills`, `linkRepoSkills`, `relinkRepoSkills`). Verify nothing else imports it:

Run: `npx tsc -p tsconfig.json --noEmit` (or `npm run build`)
Expected: no errors.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (all files). Also run `npm run lint` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/skillRepos.ts src/agent/skills.ts src/commands/builtins.ts tests/skillRepos.test.ts
git commit -m "feat(skills): link repo skills on install/update; remove links on remove"
```
