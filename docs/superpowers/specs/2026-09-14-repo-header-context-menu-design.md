# Design: repo header right-click new session

Date: 2026-09-14
Status: approved (user confirmed option A, left-click + right-click coexist)

## 1. Purpose

In multi-repo workspaces, right-clicking a repo header opens a context menu
whose first item creates a new session scoped to that repo. This makes
"new session for this repo" discoverable without changing any existing
left-click behavior.

User decisions:
- Trigger: `onContextMenu` on the repo header button
  (`src/desktop/renderer/src.tsx`, `renderSessionCard` group header).
- Left-click keeps switching `activeRepos`; right-click only opens the menu.
- Menu v1 has a single item: `New session in <repoName>`.
- The menu component takes an `items[]` array so future entries
  (copy path, collapse, reveal) require no rework of positioning or
  dismiss logic.
- Single-repo workspaces have no repo header, so they are untouched.
  TUI and session cards are out of scope.

## 2. Background / current behavior

- Renderer (`src/desktop/renderer/src.tsx:150-155`, `464`, `468`):
  `newSessionTargetFor(workspaceId)` resolves the repo a new session opens in
  (explicit `activeRepos` pick wins, else open session repo, else first repo).
  The top-left button calls `selectSession(active, undefined,
  newSessionTargetFor(active))`. Repo header `onClick` only sets
  `activeRepos[workspaceId]`.
- No `onContextMenu` handler exists anywhere in the renderer today, so the
  browser default menu appears on right-click.
- `selectSession(workspaceId, sessionId, repoId)` (`src.tsx:423-429`) is the
  single path for session switches; reuse guarantees parity with the button,
  `Ctrl+N`, and `/new`.

## 3. Approaches considered

- A (chosen): custom React context menu. `preventDefault()` on contextmenu,
  render an absolutely positioned list at the cursor. Same sidebar styling,
  no Electron main changes, easy to unit test.
- B (rejected): native Electron `Menu.popup()` via new IPC. Native look but
  needs a roundtrip through `shell/main.mjs`, harder to test, style mismatch
  with the dark sidebar. Overkill for one menu item.
- C (rejected): right-click immediately creates the session with no menu.
  Fastest but surprising, easy to misfire, and blocks future menu growth.

## 4. Detailed design

### 4.1 Component

- New `RepoContextMenu` in `src/desktop/renderer/` (own file to respect the
  `lint:size` ceiling): props `{ x, y, repoName, items, onSelect, onClose }`.
  `items` is `{ id, label, hint? }[]`; v1 passes a single
  `{ id: "new-session", label: `New session in ${repoName}` }` entry.
- State in `App` (`src.tsx`): `contextMenu: { workspaceId, repoId, x, y } |
  null`. `onContextMenu` on each `.repo-header` sets it with
  `event.clientX/clientY` and calls `event.preventDefault()`.
- Positioning: `fixed` at `(x, y)`; flip horizontally/vertically when within
  200px/120px of the viewport edge. Rendered at the root level so sidebar
  overflow never clips it.
- Dismiss: click anywhere outside, `Escape`, window blur, or scroll/resize.
  Focus the first item on open for keyboard users; `Enter` selects.

### 4.2 Behavior

- Selecting `new-session` calls `selectSession(workspaceId, undefined, repoId)`
  — the same call the top-left button makes with an explicit repo — then
  closes the menu. `ChatPane` follows its existing anonymous-session flow.
- Left-click, the New session button, `Ctrl+N`, and `/new` are unchanged.
- Menu labels use the repo display name (`group.repoName`); the full path stays
  in the header `title` tooltip.

### 4.3 Styling

- Reuse sidebar tokens (`--gui-element`, `--gui-border-strong`,
  `--gui-hover`); new `.repo-context-menu` class in
  `src/desktop/renderer/style.css`. One-line item, no icons in v1.

### 4.4 Error handling

- No new error paths: `selectSession` is synchronous state only.
  Unknown `repoId` falls back through the existing `newSessionTargetFor`
  chain. Menu state resets to `null` on selection and on dismiss.

### 4.5 Testing

- `tests/desktop-repoContextMenu.test.ts` (new): menu opens with the repo
  name in the label; selecting calls `selectSession(wid, undefined, repoId)`;
  `Escape`/outside click closes without selecting; edge-flip math covered.
- Keep touched files under `lint:size` guidance; new component stays small.

### 4.6 Files to touch

- Renderer: `src/desktop/renderer/src.tsx` (state + `onContextMenu`),
  new `src/desktop/renderer/repoContextMenu.tsx`,
  `src/desktop/renderer/style.css` (menu class).
- Tests: new file above; no backend/IPC changes.

## 5. Out of scope

- No changes to session cards, single-repo layout, TUI, or slash commands.
- No additional menu items in v1 (component is ready for them).
- No native OS menu, no drag-and-drop, no touch long-press handling.

## 6. Acceptance criteria

1. Right-clicking a repo header shows a menu with `New session in <repo>`.
2. Choosing it opens a new session in that repo, identical to left-clicking
   the header first and then pressing New session.
3. Left-click header behavior, the top button, and `/new` are unchanged.
4. Menu dismisses on outside click, `Escape`, blur, and scroll.
5. Tests in 4.5 pass; `lint:size` stays green.
