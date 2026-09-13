# Design: desktop workspace (multi-repo via .code-workspace)

Date: 2026-09-13
Status: approved (user confirmed B→A two-phase: Phase 1 session-per-repo grouping + stacked Git; Phase 2 cross-repo session later)

## 1. Purpose

Desktop app changes from "one workspace = one repo directory" to "one workspace
can hold several repos". Requirements confirmed with user:

- Workspace unit follows VS Code `.code-workspace` multi-root definition.
- Right-side Git panel shows each repo independently, stacked expanded
  (each repo collapsible, not tab-switched).
- Phase 1 keeps the agent's repo recognition unchanged (one session = one repo
  cwd). Phase 2 (cross-repo session) is explicitly out of this spec.

## 2. Background / current behavior

- `src/desktop/shellHost.ts:37-58`: `DesktopShellHost` holds
  `roots: Map<workspaceId, cwd>`. `openProject(path)` canonicalizes one directory
  into one `DesktopShellWorkspace { id, name, sessions }`.
- `restoreProjects()` replays `recentProjects` (single directories).
  `workspaceIds.ts` persists `cwd -> id` so the renderer's remembered selection
  survives restarts.
- `describe(id)` filters `SessionIndex.list()` by exact `entry.cwd === cwd`.
- `guiBackend.ts:75-92`: backend state keyed by `cwd::sessionId`. `AgentSession`,
  tools, MCP, LSP all run with that single `cwd`. The agent has no "repo"
  concept beyond cwd + `git status` output.
- `src/desktop/gitService.ts`: `DesktopGitService.status(cwd)` runs one repo.
  `shellHost.gitState(workspaceId)` resolves to one cwd.
- Renderer (`desktop/renderer/src.tsx:81-105,177-195,378-414`): left sidebar lists
  sessions of the active workspace only; project-switcher is a `<select>` over
  workspaces; right `GitInspector(workspaceId, state)` shows one repo; polling
  refreshes `refreshWorkspace(active)` + `gitState(active)` every 3s (10s hidden).

## 3. Approaches considered

- A (deferred to Phase 2): workspace root as cwd. Parse `.code-workspace`
  `folders[]`, set chat cwd to the workspace file directory, inject a repo map
  into the system prompt. Natural for cross-repo questions, but breaks the
  single-cwd permission/session boundary, confuses same-name files across repos,
  and requires `SessionIndex`/`recentProjects`/`permissionStore` rework.
- B (chosen for Phase 1): session pinned to a single repo, workspace is a group.
  Each repo keeps the existing `cwd` semantics; workspace only groups repo
  entries. Agent code untouched; only `desktop/` shell + renderer change.
  Limitation: no single-turn cross-repo edits (must switch session/repo).
- C (rejected for now): hybrid per-turn target-repo selector with tool path
  routing. Most flexible, but changes the `engine/tools` trust boundary; too big
  for this step. Revisit only after B proves the UI model.

Decision: ship B first, keep the data model forward-compatible with A (workspace
record already carries `root` + `repos[]` so a future workspace-scoped session
can reuse it).

## 4. Detailed design

### 4.1 Data model

- New shapes in `src/desktop/shellHost.ts` (or a new `workspaceRecord.ts` if
  `shellHost.ts` nears the size ceiling):
  - `DesktopRepoEntry { id: string; name: string; cwd: string }`
  - `DesktopShellWorkspace { id: string; name: string; kind: "single" | "multi"; root: string; repos: DesktopRepoEntry[]; sessions: (DesktopSessionEntry & { repoId: string })[] }`
  - `single` = today's shape (`repos` has exactly one entry, `root === cwd`).
    Old `recentProjects` entries and persisted `cwd -> id` map load as `single`
    with no migration.
  - `multi` = parsed from a `.code-workspace` file: `id` derived from the file's
    canonical path (persist via existing `workspaceIds` file keyed by file path),
    `name` = file basename without extension, `root` = file directory,
    `repos[]` = resolved `folders[].path` entries.
- `.code-workspace` parsing (new `src/desktop/codeWorkspace.ts`, pure function +
  tests):
  - Input: file path + JSON text. Accept `{ folders: [{ path: string; name?: string }] }`.
  - Resolve each `path` relative to the workspace file directory; canonicalize
    with the same `realpathSync` + win32-lowercase rule as `canonicalProjectRoot`.
  - `name` defaults to the last path segment. Duplicate cwds collapse to one
    entry. Non-existent paths are kept as entries with `missing: true` so the UI
    can render an error card (section 4.4).
  - Malformed JSON / missing `folders` throws `Invalid workspace file.` (renderer
    shows an alert, same as unavailable-directory handling today).
- Session attribution: `describe()` keeps a session when `sameProjectPath(entry.cwd,
  repo.cwd)` matches ANY repo in the workspace, and tags it with that `repoId`.
  Sessions whose cwd matches no repo are hidden from that workspace (same as today
  when cwd differs).

### 4.2 Backend + IPC

- `DesktopShellHost`:
  - `roots: Map<workspaceId, cwd>` becomes
    `workspaces: Map<workspaceId, { root: string; repos: { id: string; cwd: string; name: string; missing?: boolean }[]; source: { type: "dir" } | { type: "file"; filePath: string } }>`.
  - `openProject(selectedPath)`: if path ends with `.code-workspace` and is a file,
    parse and register as `multi`; else current directory flow as `single`.
    `recentProjects.save()` stores the selected path as given (dir or file) so
    `restoreProjects()` replays both kinds.
  - Keep `cwd(workspaceId)` for `single` callers; add `reposOf(workspaceId)` and
    `repoCwd(workspaceId, repoId)` (throw `Unknown workspace.` / `Unknown repo.`,
    mirroring existing errors).
  - `assertSession` gains repo awareness via the tagged `repoId`; rename/remove
    stay per-session and unchanged otherwise.
  - New `gitStates(workspaceId): Promise<Record<repoId, DesktopGitState>>`: loops
    `DesktopGitService.status(cwd)` per repo, never throws as a whole — a missing
    dir returns `{ isGitRepo: false, error }` for that repo only.
- IPC (`desktop/main.mjs`, `desktop/preload.cjs`, renderer window type):
  - Keep all existing `cloudcode:git-*` single-repo channels for `single`
    workspaces (no renderer branching on old paths).
  - Add `cloudcode:git-states (workspaceId) -> Record<repoId, GitState>` and reuse
    existing `gitDiff/gitStage/...` channels with an extra `repoId` argument
    convention: for `multi`, renderer passes `(workspaceId, repoId, ...)` and main
    resolves cwd via `repoCwd`. Validation via existing `requireString` helpers.
  - `openProject` dialog filter adds `*.code-workspace` alongside directories.

### 4.3 Renderer (`desktop/renderer/src.tsx`, `style.css`)

- Left sidebar: workspace `<select>` unchanged. `SESSIONS` list groups by repo:
  repo sub-header (`name`, session count, busy dot if any session in that repo is
  busy) followed by that repo's session cards. `New session` creates in the
  last-used repo of that workspace (fallback: first repo); repo shown as a small
  badge on the button and on each session card meta line.
- `selectSession` signature extends to `(workspaceId, repoId, sessionId)`; active
  session state becomes `Record<workspaceId, { repoId, sessionId }>` with fallback
  migration from the old `Record<workspaceId, sessionId>` (treat as first repo).
  `ChatPane` keeps receiving a resolved single `cwd`-backed key — Phase 1 does NOT
  change `guiBackend` turn routing or the `chatSend`/`chatHistory` wire shapes.
  The repo choice is resolved in the Electron IPC layer (`desktop/main.mjs` maps
  `(workspaceId, repoId)` to that repo's cwd via `repoCwd`, then forwards the
  existing `(cwd, sessionId)` payloads), so `cwd::sessionId` keys stay valid.
- Right panel: `GitInspector` component itself unchanged; parent maps
  `repos.map(repo => <GitInspector workspaceId repoId state>)` stacked vertically
  with per-repo header (`name`, `branch`, dirty count) and local collapse toggle
  (persist to `localStorage` per `workspaceId:repoId`). Polling extends the
  existing 3s/10s loop to fetch `gitStates(active)` once per tick instead of N
  sequential `gitState` calls. Per-repo `mutate()` refreshes only that repo.
- `StatusBar`: `gitBranch` shows the active repo's branch; when >1 repo is dirty
  shows `N repos dirty`, else current single-repo text. No new status items.

### 4.4 Error handling

- Follows AGENTS.md boundaries: no new try/catch beyond host/renderer edges.
  - Missing folder / unreadable dir: repo card shows the existing "unavailable"
    copy; chat disallows new sessions for that repo; other repos unaffected.
  - Non-git directory: reuse `Not a Git worktree.` empty state per card.
  - Duplicate folders in file / same cwd opened twice: collapse, no error.
  - Stale workspace file (moved/deleted on restore): skip entry like stale
    `recentProjects` today.
  - IPC validation failures return thrown errors; renderer surfaces via existing
    per-panel `error` line, never crashes the app.

### 4.5 Testing

- `tests/desktop-codeWorkspace.test.ts` (new): relative resolution, `name`
  fallback, dedupe, missing-path flag, malformed JSON throws.
- `tests/desktop-shellHost.test.ts`: open multi file, `reposOf`/`repoCwd`,
  session attribution across repos, `gitStates` partial failure isolates per repo,
  single-workspace backward compat.
- Renderer: extend existing fixtures (`tests/helpers/renderFixtures.ts`) with a
  multi-repo workspace; assert grouped sessions + stacked inspectors render.
- Packaging/size: no new deps; keep touched files under `lint:size` guidance.

### 4.6 Files to touch

- New: `src/desktop/codeWorkspace.ts`, `tests/desktop-codeWorkspace.test.ts`.
- Backend: `src/desktop/shellHost.ts`, `src/desktop/workspaceIds.ts` (key by file
  path too), `desktop/main.mjs`, `desktop/preload.cjs`.
- Renderer: `desktop/renderer/src.tsx`, `desktop/renderer/style.css`
  (repo group + stacked inspector styles only).
- Tests: `tests/desktop-shellHost.test.ts`, `tests/helpers/renderFixtures.ts`.
- Explicitly untouched in Phase 1: `src/engine/*`, `src/agent/*` (except
  `recentProjects` path passthrough), `src/desktop/guiBackend.ts` turn routing,
  `src/desktop/gitService.ts` git commands.

## 5. Out of scope

- Phase 2 workspace-scoped sessions (cwd = workspace root, repo map in system
  prompt, cross-repo single turn).
- Workspace file watching / auto-reload when `.code-workspace` edited externally
  (requires reopen).
- Repo add/remove inside the GUI (reopen the file instead).
- Cross-repo search, bulk commit, or aggregated diff timeline.
- TUI workspace support.

## 6. Acceptance criteria

1. Opening a `.code-workspace` file with 2+ folders shows one workspace whose
   left list groups sessions per repo and whose right panel stacks one Git card
   per repo, each independently collapsible and operable (stage/commit/push/pull).
2. Existing single-directory workspaces behave exactly as before (sessions, Git,
   polling, remembered selection).
3. A repo with a missing path or non-git dir shows a per-card error; other repos
   keep working; no app crash.
4. Killing/reopening the app restores multi workspaces and the last
   workspace/repo/session selection.
5. Tests in 4.5 pass; `npm run lint:size`, `oxlint`, and `packaging.test.ts` stay
   green.
