# GIT View: Current Commit + Push/Pull + Fetch + Recent History (Desktop GUI) — Design

Date: 2026-09-07
Status: Approved (brainstormed, 3 sections confirmed)
Scope: Desktop GUI (`desktop/renderer/src.tsx`) GIT Inspector only. TUI status bar out of scope.

## 1. Goal

Extend the desktop GUI GIT panel to show:

1. Current commit (short hash + subject first line + author + date).
2. Push / Pull buttons that run directly (same UX as Stage/Commit).
3. Sync status row (upstream name, ahead/behind, last-fetch time, manual Fetch).
4. Recent history (latest 5 commits, one line each).

User decisions locked during brainstorming:

- Commit display: short hash + subject first line (plus small author/date line for HEAD).
- Push/Pull behavior: direct `git push` / `git pull --ff-only`, wrapped in existing `mutate()` busy/error handling.
- Full option C: include fetch + 5-entry history (not minimal A, not terminal-throw-over B).

## 2. Backend changes (`src/desktop/gitService.ts`)

Extend `DesktopGitState`:

```ts
export interface DesktopGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // short date from --date=short, YYYY-MM-DD
  subject: string;
}
export interface DesktopGitState {
  // ... existing fields unchanged ...
  lastCommit?: DesktopGitCommit;
  recent: DesktopGitCommit[];
  lastFetchedAt?: number; // epoch ms, set by service after successful fetch
}
```

New service methods (all via injected `GitRunner`, no direct spawn):

- `log(cwd, limit = 5)`: runs
  `git log -<limit> --format=%H%x00%h%x00%an%x00%ad%x00%s --date=short`.
  Parses NUL-separated fields per line. Any failure returns `[]` and never fails `status()`.
- `status(cwd)`: existing `status --porcelain=v1 -z --branch` plus one `log()` call.
  First entry becomes `lastCommit`. Non-repo behavior unchanged.
- `push(cwd, setUpstreamBranch?)`: `git push`, or `git push -u origin <branch>`
  when `upstream` is missing (first push of a local-only branch).
- `pull(cwd)`: `git pull --ff-only`. Divergence surfaces stderr to the panel,
  no automatic merge is ever attempted.
- `fetch(cwd)`: `git fetch --prune`, records `lastFetchedAt` in an in-memory
  `Map<cwd, epochMs>` on success; `status()` reads that map so the timestamp
  survives across polls without touching disk.

Fetch strategy (explicit anti-slow-poll decision):

- The 3s renderer poll calls `gitState` = `status + log` only (local, fast).
- `fetch` runs only on: manual Fetch button, automatically before Pull,
  and re-`status()` refresh after successful push/pull/fetch.
- Renderer shows `origin/main · synced x min ago` from `upstream` + `lastFetchedAt`
  via a small `formatRelativeTime(lastFetchedAt)` helper in `src.tsx`
  (`<1 min` → "just now", else "N min ago" / "N h ago"); missing timestamp shows "never fetched yet".

## 3. IPC + host wiring

- `src/desktop/shellHost.ts`: expose `gitPush/gitPull/gitFetch` delegating to
  `DesktopGitService` with `this.cwd(workspaceId)`.
- `desktop/main.mjs`: add `cloudcode:git-push`, `cloudcode:git-pull`,
  `cloudcode:git-fetch` handlers using existing `requireString(workspaceId)` validation.
- `desktop/preload.cjs`: expose `gitPush/gitPull/gitFetch` on `window.cloudcode`.
- `desktop/renderer/src.tsx`: extend `GitState` type and `window.cloudcode`
  declaration with the three new calls plus new state fields.

## 4. UI layout (`GitInspector` in `desktop/renderer/src.tsx`)

Order from top (existing branch row untouched):

1. `SYNC` row: `↑{ahead} ahead · ↓{behind} behind` + `upstream ?? "untracked"` +
   `{lastFetchedAt ? "· synced x min ago" : ""}` + small `Fetch` button.
2. `Push ↑{ahead}` / `Pull ↓{behind}` primary buttons in one row.
3. `CURRENT` block: `{shortHash} {subject}` (ellipsis, title=full) +
   small gray `{author} · {date}` line. Hidden when repo has no commits
   (shows "No commits yet" instead).
4. `RECENT · 5` list: `{shortHash} {subject}` per line, ellipsis.
5. Existing `STAGED CHANGES / CHANGES / diff / COMMIT` sections unchanged.

Interaction rules:

- `Push` disabled when `!isGitRepo || busy || ahead === 0` (except untracked-branch
  case where upstream is missing: enabled, performs `-u` push).
- `Pull`/`Fetch` disabled when `!isGitRepo || busy || !upstream`.
- All three use existing `mutate()` wrapper: sets `busy`, clears `error`,
  calls `onRefresh()` on success, renders caught message in `.git-error`.
- Reuse existing `.git-group button` styles; add `.git-sync` / `.git-current` /
  `.git-recent` classes in `desktop/renderer/style.css` following the
  `.git-branch` grid pattern. No new color palette.

## 5. Error and edge cases

- Non-repo: new blocks hidden entirely; existing "Not a Git repository." remains.
- `log` failure: `recent = []`, `lastCommit = undefined`; rest of status still renders.
- No commits yet (`No commits yet on <branch>` header already handled in
  `parseDesktopGitStatus`): CURRENT shows placeholder, RECENT hidden.
- No upstream: SYNC shows "untracked — push sets upstream"; Push does
  `push -u origin <branch>`; Pull/Fetch disabled with hint.
- `pull --ff-only` divergence: stderr shown verbatim in `.git-error`,
  working tree untouched by us.
- Network failure on push/pull/fetch: button re-enables, error stays in panel,
  no dialog popup.
- Truncation: existing `truncated` flag behavior unchanged; log output is tiny
  and never sets `truncated`.

## 6. Testing

- `tests/desktop-gitService.test.ts`: log parsing (normal 5, empty repo,
  CJK/multibyte subjects), arg assertions for push (`["push"]`),
  push-upstream (`["push","-u","origin",branch]`), pull (`["pull","--ff-only"]`),
  fetch (`["fetch","--prune"]`) via fake `GitRunner`. No real git execution.
- `tests/desktop-shellHost.test.ts`: `gitState` includes `lastCommit`/`recent`.
- Renderer: no jsdom unit test (consistent with existing `src.tsx` coverage);
  verify via `npm run build` + manual GUI check.
- Size guard: `gitService.ts` ~90 lines now, expected ~160 after change,
  stays under the 600-line warning threshold (`npm run lint:size`).

## 7. Out of scope (YAGNI)

- Commit detail view / full `git show` per history row.
- Branch creation/deletion from history, rebase/merge conflict UI.
- Auto-fetch inside the 3s poll loop.
- TUI (`src/ui/widgets/statusBar.ts`, `useGitStatus.ts`) changes.
-ahead/behind i18n beyond the "ahead/behind + upstream" text already specified.
