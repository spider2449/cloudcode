# Desktop Workspace (multi-repo via .code-workspace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one desktop workspace hold several repos from a `.code-workspace` file, with sessions grouped per repo on the left and one independent Git card per repo stacked on the right.

**Architecture:** Phase 1 only (spec section 3, option B): a pure parser resolves `.code-workspace` folders to repo entries; `DesktopShellHost` groups sessions per repo and serves per-repo Git state; Electron IPC resolves `(workspaceId, repoId)` to cwd in `main.mjs`; the renderer groups sessions and stacks the unchanged `GitInspector` per repo.

**Tech Stack:** TypeScript (strict), vitest, Electron IPC (`desktop/main.mjs` + `desktop/preload.cjs`), React renderer (`desktop/renderer/src.tsx` + `style.css`).

**Spec:** `docs/superpowers/specs/2026-09-13-desktop-workspace-design.md`

## Global Constraints

- All code comments in English.
- `npm run lint:size` must stay clean (600-line warn / 1000-line fail). If `src/desktop/shellHost.ts` would cross 600 lines, extract the new workspace-record code into `src/desktop/workspaceRecord.ts` instead.
- Before every git commit, bump the patch version in `src/version.ts`, `package.json`, both `package-lock.json` version fields, and `installer/cloudcode.iss` (each task states the exact next version).
- Tests land in the same commit as the feature (per AGENTS.md testing convention).
- Run tests with `npm run test -- <file>` (this repo's runner is vitest).
- Phase 1 does NOT touch `src/engine/*`, `src/agent/*` (except `recentProjects` path passthrough, which already accepts any string), or `src/desktop/guiBackend.ts` turn routing.

---

### Task 1: `.code-workspace` parser (pure, tested)

**Files:**
- Create: `src/desktop/codeWorkspace.ts`
- Test: `tests/desktop-codeWorkspace.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `node:fs.existsSync` default, `node:path` resolve/dirname/basename).
- Produces (used by Task 2):
  - `export interface ResolvedWorkspaceRepo { id: string; name: string; cwd: string; missing: boolean }`
  - `export function parseCodeWorkspaceFile(filePath: string, text: string, exists?: (p: string) => boolean): ResolvedWorkspaceRepo[]`

- [ ] **Step 1: Write the failing test**

Append to new file `tests/desktop-codeWorkspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCodeWorkspaceFile } from "../src/desktop/codeWorkspace.js";

const FILE = "/ws/project.code-workspace";

describe("parseCodeWorkspaceFile", () => {
  it("resolves relative folders against the workspace file directory", () => {
    const repos = parseCodeWorkspaceFile(
      FILE,
      JSON.stringify({ folders: [{ path: "api" }, { path: "web", name: "Frontend" }] }),
      () => true
    );
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({ id: expect.any(String), name: "api", cwd: "/ws/api", missing: false });
    expect(repos[1]).toEqual({ id: expect.any(String), name: "Frontend", cwd: "/ws/web", missing: false });
  });

  it("flags missing paths and dedupes identical cwds", () => {
    const repos = parseCodeWorkspaceFile(
      FILE,
      JSON.stringify({ folders: [{ path: "api" }, { path: "./api" }, { path: "gone" }] }),
      p => p !== "/ws/gone"
    );
    expect(repos).toHaveLength(2);
    expect(repos.find(r => r.cwd === "/ws/gone")).toMatchObject({ name: "gone", missing: true });
  });

  it("throws on malformed JSON or missing folders", () => {
    expect(() => parseCodeWorkspaceFile(FILE, "not json", () => true)).toThrow("Invalid workspace file.");
    expect(() => parseCodeWorkspaceFile(FILE, JSON.stringify({}), () => true)).toThrow("Invalid workspace file.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-codeWorkspace.test.ts`
Expected: FAIL with `Failed to resolve import "../src/desktop/codeWorkspace.js"` (file does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/desktop/codeWorkspace.ts`:

```ts
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface ResolvedWorkspaceRepo {
  id: string;
  name: string;
  cwd: string;
  missing: boolean;
}

// Parse a VS Code .code-workspace file into repo entries. Relative folder
// paths resolve against the workspace file's own directory. Duplicate cwds
// collapse; unreadable JSON or a missing folders array throws.
export function parseCodeWorkspaceFile(
  filePath: string,
  text: string,
  exists: (p: string) => boolean = existsSync
): ResolvedWorkspaceRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid workspace file.");
  }
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders) || folders.length === 0) throw new Error("Invalid workspace file.");
  const base = dirname(filePath);
  const seen = new Set<string>();
  const repos: ResolvedWorkspaceRepo[] = [];
  folders.forEach((folder, index) => {
    const entry = folder as { path?: unknown; name?: unknown };
    if (typeof entry.path !== "string" || entry.path === "") return;
    let cwd = resolve(base, entry.path);
    if (process.platform === "win32") cwd = cwd.toLowerCase();
    if (seen.has(cwd)) return;
    seen.add(cwd);
    const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : basename(cwd) || cwd;
    repos.push({ id: `repo-${index}`, name, cwd, missing: !exists(cwd) });
  });
  return repos;
}
```

Note: `id` values are positional (`repo-0`, ...) within one parse; Task 2 assigns stable per-workspace ids when registering. If you change this contract, update Task 2's test expectations in the same edit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-codeWorkspace.test.ts`
Expected: PASS (3 tests). On Windows the `cwd` assertions differ (`\` separators + lowercase): if failures are separator-only, normalize with `replaceAll("\\", "/")` in the test expectations, not by branching the implementation.

- [ ] **Step 5: Commit (version 0.1.108)**

```bash
git add src/desktop/codeWorkspace.ts tests/desktop-codeWorkspace.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): parse .code-workspace folders into repo entries (0.1.108)"
```

Bump first: `src/version.ts` to `0.1.108`, `package.json` `version` to `0.1.108`, both `package-lock.json` version fields (lines 3 and 9) to `0.1.108`, `installer/cloudcode.iss` `#define AppVersion` to `0.1.108`. Verify with `npm run test -- tests/packaging.test.ts` before committing.

---

### Task 2: ShellHost multi-repo model + per-repo Git

**Files:**
- Modify: `src/desktop/shellHost.ts` (extend types + `openProject`/`describe`, add `reposOf`/`repoCwd`/`gitStates`)
- Modify: `tests/desktop-shellHost.test.ts` (append multi-repo describe block)

**Interfaces:**
- Consumes (from Task 1): `parseCodeWorkspaceFile(filePath, text, exists?)`, `ResolvedWorkspaceRepo`.
- Produces (used by Task 3):
  - `export interface DesktopRepoEntry { id: string; name: string; cwd: string; missing?: boolean }`
  - `DesktopShellWorkspace { id: string; name: string; kind: "single" | "multi"; root: string; repos: DesktopRepoEntry[]; sessions: (DesktopSessionEntry & { repoId: string })[] }`
  - `reposOf(workspaceId: string): DesktopRepoEntry[]`
  - `repoCwd(workspaceId: string, repoId: string): string` (throws `Unknown workspace.` / `Unknown repo.`)
  - `gitStates(workspaceId: string): Promise<Record<string, DesktopGitState>>` (per-repo isolation: one repo's failure never rejects the whole call)
- Test seam: new optional constructor dep `readWorkspaceFile?: (p: string) => string` (default: `readFileSync(p, "utf8")`).

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop-shellHost.test.ts` (follow existing `mkdtempSync` + `roots` cleanup pattern at the top of that file; extend the existing `node:fs` import with `writeFileSync`):

```ts
describe("DesktopShellHost multi-repo workspaces", () => {
  it("opens a .code-workspace file and attributes sessions per repo", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-ws-"));
    roots.push(root);
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "web"));
    writeFileSync(join(root, "shop.code-workspace"), JSON.stringify({ folders: [{ path: "api" }, { path: "web" }] }));
    // The host canonicalizes roots (lowercase on win32), so record the session
    // cwd with the same rule or attribution will miss on Windows.
    const apiCwd = process.platform === "win32" ? join(root, "api").toLowerCase() : join(root, "api");
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: apiCwd, firstMessage: "api work", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });

    const workspace = host.openProject(join(root, "shop.code-workspace"));
    expect(workspace.kind).toBe("multi");
    expect(workspace.repos.map(r => r.name).sort()).toEqual(["api", "web"]);
    expect(workspace.sessions).toEqual([expect.objectContaining({ id: "s1", repoId: workspace.repos[0].id })]);
  });

  it("isolates per-repo git failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-ws-"));
    roots.push(root);
    mkdirSync(join(root, "api"));
    writeFileSync(join(root, "shop.code-workspace"), JSON.stringify({ folders: [{ path: "api" }, { path: "gone" }] }));
    const host = new DesktopShellHost({
      recentProjects: { load: () => [], save: () => {} },
      gitRunner: async (_args, cwd) => {
        if (cwd.endsWith("gone")) return { code: 128, stdout: "", stderr: "nope", truncated: false };
        if (_args[0] === "log") return { code: 0, stdout: "", stderr: "", truncated: false };
        return { code: 0, stdout: "## main\0", stderr: "", truncated: false };
      }
    });
    const workspace = host.openProject(join(root, "shop.code-workspace"));
    const states = await host.gitStates(workspace.id);
    expect(Object.keys(states)).toHaveLength(2);
    expect(states[workspace.repos[0].id].isGitRepo).toBe(true);
    expect(states[workspace.repos[1].id].isGitRepo).toBe(false);
  });
});
```

Note: the first test's `cwd` must match `sameProjectPath` semantics — on win32 the host lowercases roots, so build the recorded cwd with the same rule the implementation uses (already handled in the test above via the platform check).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-shellHost.test.ts`
Expected: FAIL with `host.openProject(...).kind` undefined / `host.gitStates is not a function` (new block fails, existing tests pass).

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/shellHost.ts`:

1. Import the parser: `import { parseCodeWorkspaceFile } from "./codeWorkspace.js";` and `readFileSync` from `node:fs` (extend the existing `realpathSync` import).
2. Add types + replace the `roots` map (lines 38-43) with a workspace record map:

```ts
export interface DesktopRepoEntry { id: string; name: string; cwd: string; missing?: boolean }

export interface DesktopShellWorkspace {
  id: string;
  name: string;
  kind: "single" | "multi";
  root: string;
  repos: DesktopRepoEntry[];
  sessions: (DesktopSessionEntry & { repoId: string })[];
}
```

3. `openProject(selectedPath)`: if the path ends with `.code-workspace` (case-insensitive) and parses, register `{ root: dirname(file), repos }` as `multi` (workspace name = file basename minus extension; id persisted via `saveWorkspaceId(file, id)` keyed by the canonical file path); else the current single-dir flow with `repos: [{ id: "repo-0", name, cwd }]` and `kind: "single"`.
4. `describe(id)`: match sessions with `sameProjectPath(entry.cwd, repo.cwd)` against ANY repo and tag the matched `repoId`; sessions matching no repo are excluded.
5. Add:

```ts
reposOf(workspaceId: string): DesktopRepoEntry[] {
  const record = this.workspaces.get(workspaceId);
  if (!record) throw new Error("Unknown workspace.");
  return record.repos;
}

repoCwd(workspaceId: string, repoId: string): string {
  const repo = this.reposOf(workspaceId).find(r => r.id === repoId);
  if (!repo) throw new Error("Unknown repo.");
  return repo.cwd;
}

async gitStates(workspaceId: string): Promise<Record<string, DesktopGitState>> {
  const entries: Record<string, DesktopGitState> = {};
  for (const repo of this.reposOf(workspaceId)) {
    try {
      entries[repo.id] = await this.git.status(repo.cwd);
    } catch (error) {
      entries[repo.id] = { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false, recent: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  return entries;
}
```

6. Keep `cwd(workspaceId)` and `gitState(workspaceId)` working: for `single` they resolve the sole repo; for `multi` they resolve the first repo (renderer stops calling them for `multi` in Task 4, but old callers/tests must not break).
7. Add constructor option `readWorkspaceFile?: (p: string) => string` to `DesktopShellHostOptions`; default `(p) => readFileSync(p, "utf8")`. Wrap the parse in try/catch and rethrow as `Invalid workspace file.` so malformed files surface the same message the parser uses.

- [ ] **Step 4: Run tests to verify**

Run: `npm run test -- tests/desktop-shellHost.test.ts tests/desktop-codeWorkspace.test.ts tests/packaging.test.ts`
Expected: all PASS. Then `npm run lint:size` — if `src/desktop/shellHost.ts` warns (>600 lines), extract the record types + multi-register helper into `src/desktop/workspaceRecord.ts` in this same task before committing (update the import in `shellHost.ts`; no behavior change).

- [ ] **Step 5: Commit (version 0.1.109)**

```bash
git add src/desktop/shellHost.ts tests/desktop-shellHost.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): group sessions and git state per repo in a workspace (0.1.109)"
```

Bump all four version locations to `0.1.109` first.

---

### Task 3: IPC — open dialog, per-repo Git, repo-aware chat resolution

**Files:**
- Modify: `desktop/main.mjs` (dialog filter, `git-states` handler, repo-aware `host.cwd` resolution via `repoCwd`)
- Modify: `desktop/preload.cjs` (expose `gitStates` + optional `repoId` passthrough)

**Interfaces:**
- Consumes (from Task 2): `host.reposOf`, `host.repoCwd`, `host.gitStates`, `host.gitService()`.
- Produces (used by Task 4, exact channel names — the renderer implementer sees only these):
  - `cloudcode:git-states (workspaceId) -> Record<repoId, GitState>`
  - All existing `cloudcode:git-*` handlers accept an optional `repoId` as the SECOND argument after `workspaceId` (e.g. `gitStage(workspaceId, repoId?, paths)`); when omitted, behavior is exactly today's.
  - `cloudcode:chat-send` / `chat-history` / `chat-complete` / `chat-status` / `chat-statusline-set` accept optional `repoId` on the request object and resolve cwd via `repoCwd(workspaceId, repoId)` when present, else `cwd(workspaceId)` as today.
  - `cloudcode:open-project` dialog adds a `*.code-workspace` file filter.

- [ ] **Step 1: Write the failing check (no new unit test — main.mjs is untested JS)**

There is no vitest harness for `desktop/main.mjs` (it imports Electron). The failing check is static: confirm the channels do not exist yet.

Run: `rg "git-states|repoCwd" desktop/main.mjs desktop/preload.cjs`
Expected: no matches (exit non-zero), proving the new surface is absent.

- [ ] **Step 2: Implement in `desktop/main.mjs`**

1. Open dialog (line 126-130): allow picking a workspace file too:

```js
const result = await dialog.showOpenDialog(window, {
  properties: ["openDirectory", "openFile"],
  filters: [{ name: "Workspace", extensions: ["code-workspace"] }]
});
```

Keep the `canceled || filePaths.length !== 1` guard unchanged; `host.openProject` already branches on the extension (Task 2).

2. Add after the `git-state` handler (line 133):

```js
ipcMain.handle("cloudcode:git-states", (_event, workspaceId) => host.gitStates(requireString(workspaceId, "workspace ID")));
```

3. Repo-aware resolution helper (place above the git handlers):

```js
function resolveRepoCwd(workspaceId, repoId) {
  const wid = requireString(workspaceId, "workspace ID");
  if (repoId === undefined) return host.cwd(wid);
  return host.repoCwd(wid, requireString(repoId, "repo ID"));
}
```

4. Thread `repoId` through every git/chat handler that currently calls `host.cwd(...)`. Pattern per handler (example for `git-stage`):

```js
// before:
ipcMain.handle("cloudcode:git-stage", async (_event, workspaceId, paths) => host.gitService().stage(host.cwd(requireString(workspaceId, "workspace ID")), requirePaths(paths)));
// after:
ipcMain.handle("cloudcode:git-stage", async (_event, workspaceId, repoIdOrPaths, maybePaths) => {
  const paths = maybePaths === undefined ? repoIdOrPaths : maybePaths;
  const repoId = maybePaths === undefined ? undefined : repoIdOrPaths;
  return host.gitService().stage(resolveRepoCwd(workspaceId, repoId), requirePaths(paths));
});
```

Apply the same optional-second-arg shape to `git-diff`, `git-unstage`, `git-stage-all`, `git-unstage-all`, `git-commit`, `git-branches`, `git-checkout`, `git-create-branch`, `git-push`, `git-pull`, `git-fetch`. For the chat handlers (`chat-send`, `chat-history`, `chat-complete`, `chat-status`, `chat-statusline-set`), read `request.repoId` when present: `cwd = request.repoId === undefined ? host.cwd(wid) : host.repoCwd(wid, requireString(request.repoId, "repo ID"))`, keeping the existing try/catch fallbacks byte-for-byte.

- [ ] **Step 3: Expose in `desktop/preload.cjs`**

```js
gitStates: workspaceId => ipcRenderer.invoke("cloudcode:git-states", workspaceId),
```

and add optional `repoId` passthrough to each git function without changing single-repo call compatibility, e.g.:

```js
gitDiff: (workspaceId, repoIdOrPath, pathOrStaged, maybeStaged) => maybeStaged === undefined
  ? ipcRenderer.invoke("cloudcode:git-diff", workspaceId, repoIdOrPath, pathOrStaged)
  : ipcRenderer.invoke("cloudcode:git-diff", workspaceId, repoIdOrPath, pathOrStaged, maybeStaged),
```

Simpler approved alternative: expose NEW names and leave old ones untouched — `gitStates`, plus `gitDiffIn(workspaceId, repoId, path, staged)`, `gitStageIn(...)`, etc. — so old single-repo calls never risk arg-shape confusion. If you take this alternative, Task 4 must call the `*In` names for multi workspaces. Pick ONE shape and use it consistently in Task 4.

- [ ] **Step 4: Verify**

Run: `rg "git-states|repoCwd" desktop/main.mjs desktop/preload.cjs` (expect matches), then `npm run lint` (oxlint covers `desktop/*.mjs`? if not, at least `node --check desktop/main.mjs` and `node --check desktop/preload.cjs`), then `npm run test -- tests/packaging.test.ts tests/desktop-shellHost.test.ts`.
Expected: lint clean, `node --check` passes, tests PASS.

- [ ] **Step 5: Commit (version 0.1.110)**

```bash
git add desktop/main.mjs desktop/preload.cjs src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): per-repo git IPC and repo-aware cwd resolution (0.1.110)"
```

Bump all four version locations to `0.1.110` first.

---

### Task 4: Renderer — grouped sessions + stacked Git panel

**Files:**
- Create: `desktop/renderer/workspaceView.ts` (pure helpers, unit-tested)
- Test: `tests/desktop-workspaceView.test.ts`
- Modify: `desktop/renderer/src.tsx` (sidebar grouping, stacked `GitInspector`s, polling via `gitStates`, status bar label)
- Modify: `desktop/renderer/style.css` (repo group + stacked inspector styles only)

**Interfaces:**
- Consumes: Task 2 workspace shape (`kind`, `repos[]`, sessions with `repoId`); Task 3 IPC (`gitStates`, per-repo git calls).
- Produces: nothing downstream (leaf UI task).
- Pure helpers in `workspaceView.ts` (exact names — `src.tsx` imports these):
  - `export interface RepoSessionGroup { repoId: string; repoName: string; sessions: SessionRef[] }` where `SessionRef = { id: string; firstMessage: string; timestamp: string; provider: string; repoId: string }`
  - `export function groupSessionsByRepo(repos: { id: string; name: string }[], sessions: SessionRef[]): RepoSessionGroup[]`
  - `export function dirtyRepoCount(states: Record<string, { files: { length: number } } | undefined>): number`
  - `export function statusGitLabel(branch: string | undefined, dirtyCount: number, repoCount: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-workspaceView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dirtyRepoCount, groupSessionsByRepo, statusGitLabel } from "../desktop/renderer/workspaceView.js";

describe("groupSessionsByRepo", () => {
  it("groups sessions under their repo and keeps empty repos", () => {
    const groups = groupSessionsByRepo(
      [{ id: "r1", name: "api" }, { id: "r2", name: "web" }],
      [{ id: "s1", firstMessage: "hi", timestamp: "2026-09-01", provider: "local", repoId: "r2" }]
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ repoId: "r1", repoName: "api" });
    expect(groups[0].sessions).toEqual([]);
    expect(groups[1].sessions.map(s => s.id)).toEqual(["s1"]);
  });
});

describe("dirtyRepoCount + statusGitLabel", () => {
  it("counts repos with files and labels the footer", () => {
    const states = { r1: { files: [{}, {}] }, r2: { files: [] }, r3: undefined };
    expect(dirtyRepoCount(states)).toBe(1);
    expect(statusGitLabel("main", 0, 2)).toBe("main · clean");
    expect(statusGitLabel("main", 2, 2)).toBe("2 repos dirty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-workspaceView.test.ts`
Expected: FAIL with unresolvable import `../desktop/renderer/workspaceView.js`.

- [ ] **Step 3: Write minimal helpers**

Create `desktop/renderer/workspaceView.ts`:

```ts
export interface SessionRef { id: string; firstMessage: string; timestamp: string; provider: string; repoId: string }
export interface RepoSessionGroup { repoId: string; repoName: string; sessions: SessionRef[] }

// Group sessions under their repo, preserving repo order. Repos with no
// sessions still produce an (empty) group so the sidebar shows every repo.
export function groupSessionsByRepo(repos: { id: string; name: string }[], sessions: SessionRef[]): RepoSessionGroup[] {
  const byRepo = new Map<string, SessionRef[]>();
  for (const session of sessions) {
    const list = byRepo.get(session.repoId) ?? [];
    list.push(session);
    byRepo.set(session.repoId, list);
  }
  return repos.map(repo => ({ repoId: repo.id, repoName: repo.name, sessions: byRepo.get(repo.id) ?? [] }));
}

export function dirtyRepoCount(states: Record<string, { files: { length: number } } | undefined>): number {
  return Object.values(states).filter(state => (state?.files.length ?? 0) > 0).length;
}

export function statusGitLabel(branch: string | undefined, dirtyCount: number, repoCount: number): string {
  if (repoCount > 1 && dirtyCount > 0) return `${dirtyCount} repos dirty`;
  return `${branch ?? "Repository"} · ${dirtyCount > 0 ? "dirty" : "clean"}`;
}
```

- [ ] **Step 4: Wire `src.tsx` + `style.css` (no new logic beyond calling the helpers)**

1. Extend the `Workspace`/`Session` types with `kind`, `repos`, and per-session `repoId` (matching Task 2's shape); extend the `cloudcode` window type with `gitStates`.
2. Sidebar: replace the flat `activeWorkspace.sessions.map` list with `groupSessionsByRepo(activeWorkspace.repos, activeWorkspace.sessions)` groups — repo sub-header + that repo's session cards. `New session` targets the last-used repo of the workspace (fallback: first repo). `activeSessions` state becomes `Record<workspaceId, { repoId: string; sessionId: string | undefined }>` with a one-time migration from the old `Record<workspaceId, string | undefined>` shape (treat old value as `{ repoId: firstRepo.id, sessionId: old }`).
3. Right panel: replace the single `<GitInspector workspaceId>` with `activeWorkspace.repos.map(repo => <GitInspector workspaceId repoId state={gitStates[repo.id]} ...>)`, each with a header (repo name + branch + dirty dot) and a collapse toggle persisted to `localStorage` under `cloudcode.gitCollapsed.<workspaceId>.<repoId>`.
4. Polling: the existing 3s/10s effect calls `gitStates(active)` once per tick (single-repo workspaces keep calling `gitState(active)` as today — branch on `kind`).
5. `StatusBar`: replace `gitBranch`/`gitDirty` props computation with `statusGitLabel(activeRepo.branch, dirtyRepoCount(gitStates), repos.length)`.
6. `style.css`: add only these rules, following the existing `.workspace-group`/`.git-group` patterns (no other visual changes):

```css
.repo-group { margin-bottom: 8px; }
.repo-header { display: flex; align-items: center; gap: 6px; padding: 4px 6px; color: var(--gui-muted, #777d87); font-size: 11px; }
.repo-header strong { color: var(--gui-text, #d8dbe1); font-size: 12px; }
.repo-header .dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gui-warn, #d9a648); }
.git-stack { display: flex; flex-direction: column; gap: 10px; }
```
7. Chat payloads: every `chatSend`/`chatHistory`/`chatComplete`/`chatStatus`/`chatStatusLineSet` call site adds the active `repoId` for `multi` workspaces (single workspaces send no `repoId`, preserving today's wire shape exactly).

- [ ] **Step 5: Run tests to verify**

Run: `npm run test -- tests/desktop-workspaceView.test.ts tests/desktop-shellHost.test.ts tests/desktop-codeWorkspace.test.ts tests/packaging.test.ts`
Expected: all PASS. Then `npm run lint:size` (renderer files must stay under guidance) and `npm run desktop:build` to confirm the vite build compiles with the new imports.

- [ ] **Step 6: Commit (version 0.1.111)**

```bash
git add desktop/renderer/workspaceView.ts desktop/renderer/src.tsx desktop/renderer/style.css tests/desktop-workspaceView.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): grouped sessions and stacked per-repo git panel (0.1.111)"
```

Bump all four version locations to `0.1.111` first.

---

## Acceptance mapping (spec section 6)

1. Open `.code-workspace` with 2+ folders → grouped sessions + stacked Git cards: Tasks 2+3+4.
2. Single-dir workspaces unchanged: Tasks 2 (`single` kind), 3 (optional `repoId`), 4 (`kind` branch).
3. Missing/non-git repo shows per-card error, others work: Tasks 1 (`missing` flag) + 2 (`gitStates` isolation) + 4 (per-card render).
4. Restores multi workspaces + last selection across restarts: Tasks 2 (`recentProjects` replay + `workspaceIds` keyed by file path) + 4 (selection migration).
5. Tests + lint + packaging green: every task's Step 4/5.
