# Design: GUI remembers last project and session

Date: 2026-09-11
Status: approved (user chose "last pair only" scope)

## 1. Purpose

The Desktop GUI currently always restarts on the first project and each
workspace's first session; the in-memory selection is lost when the app closes.
Remember the last active project + session pair and restore it on launch.
When nothing was remembered (or it no longer exists), keep the original flow.

User decision: remember only the last active pair, not per-workspace history.

## 2. Background / current behavior

- `desktop/renderer/src.tsx`: on launch, `restoreProjects()` resolves, then
  `setActive(restored[0]?.id)` and every workspace defaults to `sessions[0]?.id`.
- Storage precedent: `readStoredWidth` / sidebar + inspector width persistence
  via `window.localStorage` wrapped in try/catch (`src.tsx` lines ~57-66,
  ~125-140).
- Selecting a session triggers the existing `ChatPane` session-switch effect,
  which clears the transcript and replays history via `chatHistory(sessionId)`.

## 3. Approaches considered

- A (chosen): renderer-side `localStorage` for the last pair. Selection state
  already lives in the renderer, so no IPC or backend changes are needed.
- B (rejected): main-process file plus new IPC channels. Round-trips
  renderer-owned state through the host for no benefit.
- C (rejected): derive "latest" from `sessions.json` timestamps. Viewing without
  sending never touches the index, and an anonymous New session has no entry,
  so the semantics are wrong.

## 4. Detailed design

### 4.1 Persist on every switch

New `useEffect` in `App` (`desktop/renderer/src.tsx`) depending on
`[active, activeSessions]` writes key `cloudcode.lastSelection`:

```json
{ "workspaceId": "<id>" | null, "sessionId": "<id>" | null }
```

- `sessionId: null` means the user left that workspace on an anonymous New
  session (`activeSessions[workspaceId] === undefined`).
- `workspaceId: null` when no project is open.
- The whole write is wrapped in try/catch; a storage failure (private mode,
  quota) silently keeps the old value and the next launch falls back to the
  original flow.
- Saving on every switch (not only on quit) is crash-safe. `selectSession`,
  `switchWorkspace`, `deleteSession`, and `openProject` need no changes; the
  effect observes their state updates.

### 4.2 Restore on launch

In the existing `restoreProjects().then(...)` effect:

1. Load candidates as today (`restored` array).
2. Parse the stored value with `parseStoredSelection` (returns `undefined` on
   missing, malformed, or wrong-shaped data) — any failure proceeds exactly as
   today.
3. `target = restored.find(w => w.id === stored.workspaceId) ?? restored[0]`.
   If there is no workspace at all, behave exactly as today
   (`setActive(undefined)`, empty selection map).
   Prerequisite (fixed 2026-09-11 after a failed manual test): workspace ids
   must be stable across restarts. `DesktopShellHost.openProject` used to mint
   a fresh `randomUUID()` per process, so a stored id could never match and
   restore always fell back. Ids are now persisted per canonical project path
   (`desktop-workspace-ids.json` via `src/desktop/workspaceIds.ts`) and reused
   on reopen; only genuinely new directories mint an id.
4. `activeSessions` starts from today's defaults (`sessions[0]?.id` per
   workspace), then overrides only the target workspace:
   - stored `sessionId` is `null` → `undefined` (open on New session). A `null`
     is only stored when the workspace was left on a content-free anonymous
     session: once an anonymous turn completes, the backend pushes a
     `session_id` event and the shell silently adopts the real id (no
     transcript reset, no refetch), so quitting afterwards restores the full
     conversation. Adoption is skipped if the user already navigated elsewhere
     mid-turn;
   - stored `sessionId` matches one of `target.sessions` → that id;
   - otherwise (session renamed is fine since rename keeps the id; session
     deleted) → the workspace's `sessions[0]?.id`.
5. Other workspaces keep today's defaults; `openProject` for brand-new projects
   is untouched.

### 4.3 New module for testability

Pure logic lives in `desktop/renderer/lastSelection.ts` (no React, no
`window`):

- `parseStoredSelection(raw: string | null): { workspaceId: string; sessionId: string | null } | undefined`
- `resolveRestoredSelection(workspaces: Workspace[], stored: ...): { active: string | undefined; activeSessions: Record<string, string | undefined> }`
- `serializeSelection(active, activeSessions): string`

`src.tsx` only wires these to `localStorage` and state. The `Workspace` shape
is the existing `{ id: string; name: string; sessions: Session[] }`.

### 4.4 Error handling

- Malformed JSON, wrong types, unknown workspace id, unknown session id: all
  fall back to today's behavior, never throw, never show an error.
- Storage write failure: ignored (next launch falls back).
- A stored anonymous session (`null`) on a workspace whose session list is
  empty still resolves to `undefined`, which is the same New-session view.

### 4.5 Testing

- New `tests/desktop-lastSelection.test.ts` covering: normal restore, anonymous
  (`null`) restore, unknown workspace id, unknown (deleted) session id,
  malformed JSON variants (`null`, `""`, `"{"`, wrong types), empty workspace
  list, and `serializeSelection` round-trip.
- Existing suites must stay green; `npm run desktop:build` must succeed.

### 4.6 Files to touch

- Create: `desktop/renderer/lastSelection.ts`, `tests/desktop-lastSelection.test.ts`,
  `src/desktop/workspaceIds.ts`, `tests/desktop-workspaceIds.test.ts`
- Modify: `desktop/renderer/src.tsx` (restore effect + persist effect only),
  `src/desktop/shellHost.ts` (stable ids in `openProject`)

## 5. Out of scope

- Per-workspace session memory beyond the last pair.
- Remembering scroll position, composer draft, inspector tab, or window size.
- Any backend, IPC, `sessions.json`, or TUI changes.
- Syncing the remembered selection across machines.

## 6. Acceptance criteria

1. Quit on project P + session S, relaunch → lands on P + S with its transcript.
2. Quit on project P in New-session state, relaunch → lands on P with an empty
   New session.
3. Delete/rename between launches, or corrupt the stored value → original flow
   (first project, first sessions), no errors.
4. First-ever launch (nothing stored) → behavior identical to today.
5. New unit tests cover section 4.5; full suite, lint, `lint:size`, and
   `desktop:build` stay green.
