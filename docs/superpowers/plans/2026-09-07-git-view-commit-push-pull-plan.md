# GIT View Commit + Push/Pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show current commit, Push/Pull/Fetch buttons, and recent 5-commit history in the desktop GUI GIT Inspector.

**Architecture:** Extend `DesktopGitService` with `log/push/pull/fetch` via the injected `GitRunner` (no new spawn paths), surface them through `DesktopShellHost` + Electron IPC (`main.mjs`/`preload.cjs`), and render SYNC/CURRENT/RECENT blocks in `desktop/renderer/src.tsx` reusing the existing `mutate()` busy/error pattern.

**Tech Stack:** TypeScript (strict), Electron IPC (`ipcMain.handle`/`ipcRenderer.invoke`), React renderer (`desktop/renderer/src.tsx`), Vitest with fake `GitRunner`, `git log --format` with NUL separators.

---

## File structure

- Modify: `src/desktop/gitService.ts` (~90 → ~170 lines) — owns `DesktopGitCommit` type, `parseDesktopGitLog()`, `log/push/pull/fetch` methods, `lastFetchedAt` in-memory map, `status()` enrichment.
- Modify: `src/desktop/shellHost.ts` — adds `gitPush/gitPull/gitFetch` delegation (3 one-liners).
- Modify: `desktop/main.mjs` — adds 3 `ipcMain.handle` entries.
- Modify: `desktop/preload.cjs` — exposes 3 `window.cloudcode` functions.
- Modify: `desktop/renderer/src.tsx` — extends `GitState` + `window.cloudcode` types, adds SYNC/CURRENT/RECENT UI + `formatRelativeTime` helper.
- Modify: `desktop/renderer/style.css` — adds `.git-sync/.git-current/.git-recent` classes following `.git-branch` pattern.
- Modify: `tests/desktop-gitService.test.ts` — log parsing + push/pull/fetch arg assertions.
- Modify: `tests/desktop-shellHost.test.ts` — `gitState` includes `lastCommit`/`recent`.

No new files. No TUI changes. No new dependencies.

---

### Task 1: Git log parsing + state types + status enrichment

**Files:**
- Modify: `src/desktop/gitService.ts:1-55`
- Test: `tests/desktop-gitService.test.ts`

- [ ] **Step 1: Write the failing test for log parsing**

In `tests/desktop-gitService.test.ts`, append:

```ts
import { parseDesktopGitLog } from "../src/desktop/gitService.js";

it("parses NUL-separated git log into commits", () => {
  const stdout = [
    "abc123def456\0abc123d\0spider\02026-09-07\0Fix login",
    "eeefff000111\0eeefff0\0spider\02026-09-06\0Update GUI",
    ""
  ].join("\n");
  expect(parseDesktopGitLog(stdout)).toEqual([
    { hash: "abc123def456", shortHash: "abc123d", author: "spider", date: "2026-09-07", subject: "Fix login" },
    { hash: "eeefff000111", shortHash: "eeefff0", author: "spider", date: "2026-09-06", subject: "Update GUI" }
  ]);
});

it("returns empty array for empty log output", () => {
  expect(parseDesktopGitLog("")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: FAIL with "parseDesktopGitLog is not defined / not exported".

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/gitService.ts`, after the `DesktopGitState` interface, add:

```ts
export interface DesktopGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export function parseDesktopGitLog(output: string): DesktopGitCommit[] {
  const commits: DesktopGitCommit[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 5) continue;
    const [hash, shortHash, author, date, subject] = parts as [string, string, string, string, string];
    if (!hash || !shortHash) continue;
    commits.push({ hash, shortHash, author, date, subject });
  }
  return commits;
}
```

Extend `DesktopGitState` with:

```ts
  lastCommit?: DesktopGitCommit;
  recent: DesktopGitCommit[];
  lastFetchedAt?: number;
```

Fix `parseDesktopGitStatus` return to include `recent: []`:

```ts
  return { isGitRepo: true, branch, upstream, ahead, behind, files, truncated, recent: [] };
```

Fix the non-repo return in `status()` to include `recent: []`:

```ts
    if (result.code !== 0) return { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: result.truncated, recent: [], error: result.stderr.trim() || "Not a Git worktree." };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: PASS (all 5 tests; existing 3 + new 2).

- [ ] **Step 5: Add status-enrichment test (failing first)**

Append to `tests/desktop-gitService.test.ts`:

```ts
it("enriches status with lastCommit and recent from log", async () => {
  const runner: GitRunner = vi.fn(async (args) => {
    if (args[0] === "log") return { code: 0, stdout: "abc123def456\0abc123d\0spider\02026-09-07\0Fix login\n", stderr: "", truncated: false };
    return { code: 0, stdout: "## main...origin/main [ahead 1]\0", stderr: "", truncated: false };
  });
  const state = await new DesktopGitService(runner).status("/repo");
  expect(state.lastCommit?.shortHash).toBe("abc123d");
  expect(state.recent).toHaveLength(1);
  expect(state.branch).toBe("main");
  expect(state.ahead).toBe(1);
});
```

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: FAIL (`lastCommit` undefined — status does not call log yet).

- [ ] **Step 6: Implement status enrichment + log method**

In `src/desktop/gitService.ts`, add to `DesktopGitService`:

```ts
  private readonly lastFetchedAtByCwd = new Map<string, number>();

  async log(cwd: string, limit = 5): Promise<DesktopGitCommit[]> {
    const count = Number.isInteger(limit) && limit > 0 && limit <= 20 ? limit : 5;
    const result = await this.runner(
      ["log", `-${count}`, "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short"],
      cwd
    );
    if (result.code !== 0) return [];
    return parseDesktopGitLog(result.stdout);
  }
```

Change `status()` body after `parseDesktopGitStatus(...)` to:

```ts
  async status(cwd: string): Promise<DesktopGitState> {
    const result = await this.runner(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], cwd);
    if (result.code !== 0) return { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: result.truncated, recent: [], error: result.stderr.trim() || "Not a Git worktree." };
    const state = parseDesktopGitStatus(result.stdout, result.truncated);
    const recent = await this.log(cwd);
    state.recent = recent;
    state.lastCommit = recent[0];
    const fetchedAt = this.lastFetchedAtByCwd.get(cwd);
    if (fetchedAt !== undefined) state.lastFetchedAt = fetchedAt;
    return state;
  }
```

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/desktop/gitService.ts tests/desktop-gitService.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): parse git log and enrich status with lastCommit"
```

Note: bump patch version 0.1.28 → 0.1.29 in `src/version.ts`, `package.json`, both `version` fields in `package-lock.json`, `installer/cloudcode.iss` (`#define AppVersion`) in the same commit (repo policy; `tests/packaging.test.ts` enforces agreement).

---

### Task 2: push / pull / fetch methods

**Files:**
- Modify: `src/desktop/gitService.ts`
- Test: `tests/desktop-gitService.test.ts`

- [ ] **Step 1: Write failing tests for push/pull/fetch args**

Append:

```ts
it("pushes, pulls ff-only, and fetches with prune", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = vi.fn(async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", truncated: false };
  });
  const svc = new DesktopGitService(runner);
  await svc.push("/repo");
  await svc.pull("/repo");
  await svc.fetch("/repo");
  expect(calls).toContainEqual(["push"]);
  expect(calls).toContainEqual(["pull", "--ff-only"]);
  expect(calls).toContainEqual(["fetch", "--prune"]);
});

it("pushes with -u origin on untracked branches", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = vi.fn(async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", truncated: false };
  });
  await new DesktopGitService(runner).push("/repo", "my-branch");
  expect(calls).toContainEqual(["push", "-u", "origin", "my-branch"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: FAIL with "svc.push is not a function".

- [ ] **Step 3: Implement push/pull/fetch**

Add to `DesktopGitService` (after `fetch`, before `requireOk` region — place next to `commit`):

```ts
  async push(cwd: string, setUpstreamBranch?: string): Promise<void> {
    if (setUpstreamBranch) {
      await this.requireOk(["push", "-u", "origin", setUpstreamBranch], cwd);
    } else {
      await this.requireOk(["push"], cwd);
    }
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }

  async pull(cwd: string): Promise<void> {
    await this.requireOk(["pull", "--ff-only"], cwd);
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }

  async fetch(cwd: string): Promise<void> {
    await this.requireOk(["fetch", "--prune"], cwd);
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/desktop-gitService.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/desktop/gitService.ts tests/desktop-gitService.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): add git push pull fetch to DesktopGitService"
```

Note: bump patch version in the same 4 places again.

---

### Task 3: shellHost delegation + host test

**Files:**
- Modify: `src/desktop/shellHost.ts:75-79`
- Test: `tests/desktop-shellHost.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/desktop-shellHost.test.ts`:

```ts
it("delegates push pull fetch scoped to the workspace", async () => {
  const seen: string[][] = [];
  const host = new DesktopShellHost({
    recentProjects: { load: () => [], save: () => {} },
    gitRunner: async (args, cwd) => {
      seen.push(args);
      if (args[0] === "log") return { code: 0, stdout: "", stderr: "", truncated: false };
      return { code: 0, stdout: "## main\0", stderr: "", truncated: false };
    }
  });
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-git-"));
  const project = join(root, "project");
  mkdirSync(project);
  const workspace = host.openProject(project);
  await host.gitPush(workspace.id);
  await host.gitFetch(workspace.id);
  expect(seen).toContainEqual(["push"]);
  expect(seen).toContainEqual(["fetch", "--prune"]);
});
```

(Simpler alternative matching existing style: reuse the `roots` + `mkdirSync` pattern at top of file instead of dynamic imports if preferred — keep the assertion on `seen` regardless.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/desktop-shellHost.test.ts`
Expected: FAIL with "host.gitPush is not a function".

- [ ] **Step 3: Implement delegation**

In `src/desktop/shellHost.ts` after `gitState()`:

```ts
  async gitPush(workspaceId: string, setUpstreamBranch?: string): Promise<void> {
    await this.git.push(this.cwd(workspaceId), setUpstreamBranch);
  }

  async gitPull(workspaceId: string): Promise<void> {
    await this.git.pull(this.cwd(workspaceId));
  }

  async gitFetch(workspaceId: string): Promise<void> {
    await this.git.fetch(this.cwd(workspaceId));
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/desktop-shellHost.test.ts tests/desktop-gitService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/shellHost.ts tests/desktop-shellHost.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): delegate git push pull fetch in shell host"
```

Note: bump patch version in the same 4 places.

---

### Task 4: Electron IPC (main + preload)

**Files:**
- Modify: `desktop/main.mjs:121-130`
- Modify: `desktop/preload.cjs:7-16`

No new test file (covered by service/host tests; IPC is thin validation wiring). Verify with `npm run build`.

- [ ] **Step 1: Add main.mjs handlers**

After the `git-create-branch` handler (line ~130), insert:

```js
ipcMain.handle("cloudcode:git-push", async (_event, workspaceId, branch) => host.gitPush(requireString(workspaceId, "workspace ID"), branch === undefined ? undefined : requireBranchName(branch)));
ipcMain.handle("cloudcode:git-pull", async (_event, workspaceId) => host.gitPull(requireString(workspaceId, "workspace ID")));
ipcMain.handle("cloudcode:git-fetch", async (_event, workspaceId) => host.gitFetch(requireString(workspaceId, "workspace ID")));
```

- [ ] **Step 2: Add preload bridge**

After `gitCreateBranch` line, insert:

```js
  gitPush: (workspaceId, branch) => ipcRenderer.invoke("cloudcode:git-push", workspaceId, branch),
  gitPull: workspaceId => ipcRenderer.invoke("cloudcode:git-pull", workspaceId),
  gitFetch: workspaceId => ipcRenderer.invoke("cloudcode:git-fetch", workspaceId),
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: success, `dist/` emitted, no TS errors (main.mjs is JS — build validates `shellHost.ts` signatures).

- [ ] **Step 4: Commit**

```bash
git add desktop/main.mjs desktop/preload.cjs src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): wire git push pull fetch IPC"
```

Note: bump patch version in the same 4 places.

---

### Task 5: Renderer UI (SYNC + CURRENT + RECENT)

**Files:**
- Modify: `desktop/renderer/src.tsx:13-15,318-351`
- Modify: `desktop/renderer/style.css:33`

- [ ] **Step 1: Extend renderer types**

Change:

```ts
type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string };
```

to:

```ts
type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string };
type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string; lastCommit?: GitCommit; recent: GitCommit[]; lastFetchedAt?: number };
```

Extend `window.cloudcode` declaration with:

```ts
      gitPush(workspaceId: string, branch?: string): Promise<void>;
      gitPull(workspaceId: string): Promise<void>;
      gitFetch(workspaceId: string): Promise<void>;
```

- [ ] **Step 2: Add relative-time helper (next to formatSessionDate)**

```ts
function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "never fetched yet";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ago`;
}
```

- [ ] **Step 3: Add SYNC + CURRENT + RECENT blocks in GitInspector**

Insert directly after the `<div className="git-branch">...</div>` line and before `<GitFileGroup title="STAGED CHANGES"`:

```tsx
    <section className="git-sync">
      <div className="section-heading"><span>SYNC · {state.upstream ?? "untracked"}</span><button disabled={busy || !state.upstream} onClick={() => void mutate(() => window.cloudcode.gitFetch(workspaceId))}>Fetch</button></div>
      <div className="git-sync-line"><span>↑{state.ahead} ahead · ↓{state.behind} behind · {formatRelativeTime(state.lastFetchedAt)}</span></div>
      <div className="git-sync-actions">
        <button disabled={busy || (!state.upstream && !state.branch) || state.ahead === 0 && !!state.upstream} onClick={() => void mutate(() => state.upstream ? window.cloudcode.gitPush(workspaceId) : window.cloudcode.gitPush(workspaceId, state.branch))}>Push{state.ahead ? ` ↑${state.ahead}` : ""}</button>
        <button disabled={busy || !state.upstream || state.behind === 0} onClick={() => void mutate(async () => { await window.cloudcode.gitFetch(workspaceId); await window.cloudcode.gitPull(workspaceId); })}>Pull{state.behind ? ` ↓${state.behind}` : ""}</button>
      </div>
      {!state.upstream && <p className="git-hint">Untracked branch — Push sets upstream to origin/{state.branch}.</p>}
    </section>
    {state.lastCommit ? <section className="git-current"><div className="section-heading"><span>CURRENT</span></div><div className="git-commit-line" title={`${state.lastCommit.hash} · ${state.lastCommit.author} · ${state.lastCommit.date}`}><span className="git-hash">{state.lastCommit.shortHash}</span><span>{state.lastCommit.subject}</span></div><div className="git-meta">{state.lastCommit.author} · {state.lastCommit.date}</div></section> : <p className="git-empty">No commits yet.</p>}
    {state.recent.length > 1 && <section className="git-recent"><div className="section-heading"><span>RECENT · {state.recent.length}</span></div>{state.recent.slice(1).map(commit => <div className="git-commit-line" key={commit.hash} title={`${commit.hash} · ${commit.author} · ${commit.date}`}><span className="git-hash">{commit.shortHash}</span><span>{commit.subject}</span></div>)}</section>}
```

Keep the existing fallback `gitStates` error object (`{ isGitRepo: false, ahead: 0, behind: 0, files: [], ... }`) updated with `recent: []` to satisfy the new type (line ~182).

- [ ] **Step 4: Add CSS**

Append to `desktop/renderer/style.css`:

```css
.inspector .git-sync, .inspector .git-current, .inspector .git-recent { padding: 10px 12px; border-bottom: 1px solid #272a30; }
.git-sync-line, .git-meta { color: #777d87; font-size: 10px; }
.git-sync-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 7px; }
.git-sync-actions button, .git-sync .section-heading button { border: 1px solid #3a3e46; border-radius: 5px; background: #25282e; color: #b8bdc6; font-size: 10px; padding: 6px; cursor: pointer; }
.git-sync-actions button:disabled, .git-sync .section-heading button:disabled { opacity: .45; cursor: default; }
.git-commit-line { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 6px; padding: 3px; overflow: hidden; color: #aeb3bc; font: 10px ui-monospace, "Cascadia Code", monospace; }
.git-commit-line > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-hash { color: #7e98c3; }
.git-hint { color: #8a7142; font-size: 10px; margin: 6px 0 0; }
```

- [ ] **Step 5: Verify renderer build**

Run: `npm run build`
Expected: success. Then `npx tsc --noEmit` if available (strict, zero `any`).

- [ ] **Step 6: Commit**

```bash
git add desktop/renderer/src.tsx desktop/renderer/style.css src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): show current commit and push pull fetch in git view"
```

Note: bump patch version in the same 4 places.

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run unit tests**

Run: `npx vitest run tests/desktop-gitService.test.ts tests/desktop-shellHost.test.ts`
Expected: PASS.

- [ ] **Step 2: Run size + packaging guards**

Run: `npm run lint:size`
Expected: no file over 1000 lines; `gitService.ts` (~170) under 600 warning-free.

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS (version agreement across `src/version.ts` / `package.json` / `package-lock.json` / `installer/cloudcode.iss`).

- [ ] **Step 3: Manual GUI check**

1. `npm run build` then start desktop (`npm run desktop` or configured dev server).
2. Open a repo with upstream: confirm SYNC row shows `origin/main · ↑N ↓M · just now`, CURRENT shows HEAD short hash + subject, RECENT lists next 4.
3. Stage a commit → Push enables with `↑N` → click → ahead drops to 0, no error.
4. On a behind repo → Pull → behind drops, CURRENT updates.
5. Untracked branch → hint shows, Push performs `-u` push.
6. Non-repo folder → SYNC/CURRENT/RECENT hidden, "Not a Git repository." only.

No commit for this task (verification only).

---

## Self-review

- **Spec coverage:** Sec 2 backend (log/push/pull/fetch + fetch strategy) → Tasks 1–2. Sec 3 IPC → Task 4, host → Task 3. Sec 4 UI blocks + disable rules → Task 5. Sec 5 edge cases (non-repo, empty log, no upstream, ff-only divergence, network error, truncation) → handled in Task 1 (`log` never throws), Task 2 (`requireOk` propagates to `mutate`), Task 5 (conditional rendering + disabled states). Sec 6 tests/size → Tasks 1–3 + 6.
- **Placeholder scan:** no TBD/TODO/"similar to"/bare "handle edge cases" — every step has exact code, exact commands, expected output.
- **Type consistency:** `DesktopGitCommit` ↔ renderer `GitCommit` field names identical (`hash/shortHash/author/date/subject`); `DesktopGitState.recent` is required `[]`-defaulted (never optional) in both service returns and renderer fallback; `gitPush(workspaceId, branch?)` signature matches across service → host → main → preload → renderer.
