# Design: /new parity + session list rename/delete

Date: 2026-09-11
Status: approved (user confirmed A+A, hover buttons, delete index+file with confirm)

## 1. Purpose

Two requests, one spec:

1. In-session `/new` must behave exactly like the top-left "New Session" button.
2. The left sessions list needs edit affordances: rename and delete.

User decisions:
- `/clear`, `/new`, and the New Session button are all identical ("三者全同").
- Interaction: hover reveals edit/delete buttons on the session card.
- Delete removes the `sessions.json` entry AND the transcript `.jsonl` file, requires
  confirmation, and switches to New session when the active session is deleted.
- Rename edits the displayed title, i.e. the `firstMessage` field.

## 2. Background / current behavior

- TUI (`src/commands/builtins.ts:191-192` for `/clear`, `:273-274` for `/new`):
  both call `ctx.clearSession()`. `App.buildCommandContext` (`src/ui/nativeApp.ts:321-331`)
  already implements fresh semantics (clear buffer, `CLEAR_AND_HOME`, `appendWelcome`,
  `restartSession` with no resume). The only difference is `/clear` appends
  `notice("Started a new session.")`.
- Desktop GUI (`src/desktop/guiCommandContext.ts:74-77`): `clearSession` only does
  `restartSession()` on the same `cwd::sessionId` key, i.e. it restarts the SAME
  resumed session. The New Session button (`desktop/renderer/src.tsx:236`) instead
  calls `selectSession(active, undefined)`, which makes `ChatPane` switch to the
  anonymous session and issue `chatHistory(undefined)`; the backend (`src/cli.tsx:283-303`)
  treats that as the fresh-start signal via `disposeKey(sessionKey(cwd, undefined))`.
  These two paths are fundamentally different today; that is the gap to close.
- Sessions persistence: `SessionIndex` (`src/agent/sessionIndex.ts`) has
  record/list/touch only. `SessionFile` (`src/engine/sessions.ts`) has
  append/rewrite/load only. `DesktopShellHost.describe` (`src/desktop/shellHost.ts:93-102`)
  re-reads the index on every `refresh` (renderer polls every 3s). The renderer has
  no edit UI and no rename/delete IPC.

## 3. Approaches considered

### 3.1 /new parity

- A (chosen): backend emits a `new_session` chat event; the renderer handles it by
  calling the exact same `selectSession(workspaceId, undefined)` function the button
  uses. Single code path, guarantees parity.
- B (rejected): frontend intercepts `/new` text locally and never sends it to the
  backend. Fast but bypasses the slash pipeline (args, skill overrides) and diverges
  across clients.
- C (rejected): `GuiServer` disposes both the named and anonymous keys while the
  frontend stays on the old id. The next turn's `recordGuiTurn` would `touch` the old
  id and resurrect it, so it is a fake new session.

### 3.2 Rename/delete

- A (chosen): full IPC plus `SessionIndex` methods. Clean layering per AGENTS.md:
  persistence in `agent/`, navigation authority in `shellHost`, UI in the renderer.
- B (rejected): renderer-only `localStorage` title overrides. The 3s poll would
  overwrite them, the TUI would not see them, and `.jsonl` files would leak.
- C (rejected): new `/rename` and `/delete` slash commands. Larger command surface
  and still needs the buttons the user asked for.

## 4. Detailed design

### 4.1 /new unification

- `src/commands/builtins.ts`: make `/clear` and `/new` identical bodies
  (`await ctx.clearSession()` with no extra notice). Unify `description` strings
  to "Start a new session".
- `src/desktop/guiCommandContext.ts`: add `requestNewSession(): void` to
  `GuiCommandDeps`. `clearSession` becomes `await deps.restartSession()` followed by
  `deps.requestNewSession()`. Disposing the current key first reuses the existing
  `disposeKey` turn-settlement logic (`src/cli.tsx:169-181`).
- `src/cli.tsx` `buildContext`: implement `requestNewSession` as
  `emit({ id, type: "new_session" })` on the slash request's correlation id.
- `src/desktop/chatProtocol.ts`: add `"new_session"` to `CHAT_EVENT_TYPES`.
- `desktop/renderer/chatPane.tsx`: accept `onRequestNewSession?: (workspaceId) => void`;
  in the `onChatEvent` subscription, branch on `event.type === "new_session"` and
  invoke the callback with the current `workspaceId`. The existing session-switch
  `useEffect` (clears messages, calls `chatHistory(undefined)`) then runs unchanged.
- `desktop/renderer/src.tsx`: pass `(wid) => selectSession(wid, undefined)` as the
  callback. No new welcome banner; the existing empty-state copy
  ("Your first message will name this session.") covers it.
- Edge cases: `/new` inside the anonymous session resets the anonymous backend
  session (same as pressing the button while already on New session). `/new` inside
  a named session disposes the named key and switches to anonymous. The optimistic
  user bubble echoed by `send()` is discarded by the session-switch effect.

### 4.2 Rename / delete

- `src/agent/sessionIndex.ts`:
  - `rename(id: string, firstMessage: string): void` — reloads, trims, rejects empty
    titles (no-op), updates the entry, refreshes `timestamp` so the renamed session
    sorts first (same as `touch`), persists.
  - `remove(id: string): void` — reloads, filters the entry, persists. Unknown ids
    are ignored, mirroring `touch`.
- `src/engine/sessions.ts`:
  - `SessionFile.delete(sessionId: string, dir?: string): void` — `rmSync` with
    `force: true`; missing files are not errors.
- `src/desktop/shellHost.ts`:
  - `renameSession(workspaceId, sessionId, title)` — `assertSession` (workspace
    ownership) then `sessionIndex.rename`.
  - `removeSession(workspaceId, sessionId)` — `assertSession`, then
    `sessionIndex.remove` plus `SessionFile.delete`. Cross-workspace ids throw
    "Session does not belong to this workspace."
- IPC (`desktop/main.mjs`, `desktop/preload.cjs`, `desktop/renderer/src.tsx` window type):
  - `cloudcode:rename-session` (workspaceId, sessionId, title) -> refreshed workspace.
  - `cloudcode:remove-session` (workspaceId, sessionId) -> refreshed workspace.
  - Validation via existing `requireString` helpers; confirmation lives in the
    renderer, not the host.
- Renderer (`desktop/renderer/src.tsx` workspace list, `desktop/renderer/style.css`):
  - Each session row becomes a wrapper containing the existing select button plus a
    hover-actions span with rename (pencil) and delete (trash) buttons. Visibility
    follows the existing `.workspace-more` pattern (`opacity: 0`, reveal on
    `:hover` / `:focus-within` for keyboard users).
  - Rename opens an inline `<input>` prefilled with the title; Enter or blur
    confirms, Esc cancels. Empty input keeps the old value. On confirm, call
    `renameSession` and optimistically update `workspaces` state; the 3s
    `refreshWorkspace` poll converges to the persisted value.
  - Delete calls `window.confirm("Delete this session? This removes it from the list
    and deletes its transcript.")`; only on accept calls `removeSession`. If the
    deleted id equals the workspace's active session, call
    `selectSession(workspaceId, undefined)` so `ChatPane` clears via its existing
    `chatHistory(undefined)` flow.
  - Title rendering stays `firstMessage || "Untitled session"`. Rename writes to
    `firstMessage`. Title length cap: 200 characters, trimmed; longer input is
    truncated client-side before sending.
- No changes to `recordGuiTurn` or history replay; first-message naming of future
  sessions is untouched.

### 4.3 Error handling

- Follows the repo's three boundaries (AGENTS.md): tool errors, turn errors, and
  command dispatch already have handlers; new code adds no try/catch beyond:
  - `SessionIndex` file errors keep the existing reload/record fallback pattern.
  - `SessionFile.delete` swallows missing-file errors.
  - IPC handlers validate ids with `requireString`/`requireChatId` and return
    thrown errors to the renderer, which surfaces them via `alert` or a notice
    without crashing (matches existing `gitState` refresh fallback).
- `rename` with empty/whitespace title is a no-op. Titles are capped at 200
  characters (trimmed, truncated client-side before sending). Unknown ids in
  `touch`/`remove` are no-ops. `removeSession` only deletes persisted state; if the
  deleted session was active, the renderer has already switched to the anonymous
  session, so the next message creates a fresh anonymous entry and never resurrects
  the deleted id.

### 4.4 Testing

- `tests/sessionIndex.test.ts`: rename updates title and bumps recency; rename with
  empty title is a no-op; remove drops the entry and persists; unknown ids do not throw.
- `tests/desktop-shellHost.test.ts`: rename/remove delegate correctly; cross-workspace
  ids throw; remove deletes the `.jsonl` file (use temp dirs).
- `tests/desktop-guiCommandContext.test.ts`: `/new` (`clearSession`) triggers
  `requestNewSession` after `restartSession`.
- `tests/desktop-chatProtocol.test.ts` (or chatEvents): `new_session` is a known event
  type and passes through the renderer-facing pipeline.
- `tests/desktop-chatPane.test.ts`: a `new_session` event invokes `onRequestNewSession`
  with the workspace id (add if the harness allows; otherwise cover via guiServer-level test).
- `tests/desktop-chatParity.test.ts`: update only if `/clear` description changes break
  the slash-name snapshot (names are unchanged, so likely untouched).
- Keep all touched files under the `lint:size` guidance (600-line warn, 1000-line fail).

### 4.5 Files to touch

Backend/persistence: `src/agent/sessionIndex.ts`, `src/engine/sessions.ts`,
`src/desktop/shellHost.ts`, `src/desktop/guiCommandContext.ts`,
`src/desktop/chatProtocol.ts`, `src/cli.tsx`, `src/commands/builtins.ts`.
Desktop shell: `desktop/main.mjs`, `desktop/preload.cjs`.
Renderer: `desktop/renderer/src.tsx`, `desktop/renderer/chatPane.tsx`,
`desktop/renderer/style.css`.
Tests: files listed in 4.4.

## 5. Out of scope

- No `/rename` or `/delete` slash commands.
- No soft-delete, trash, or undo for deleted sessions.
- No TUI sidebar or TUI session picker changes (`/resume` picker untouched).
- No bulk delete, no search/filter in the sessions list.
- No change to first-message auto-naming or to `recordGuiTurn` semantics.

## 6. Acceptance criteria

1. Typing `/new` in any Desktop session clears the transcript and lands on New
   session, indistinguishable from clicking the top-left button.
2. `/clear` and `/new` behave identically in both TUI and Desktop.
3. Hovering a session card reveals rename and delete affordances, keyboard-focusable.
4. Rename persists across app restarts and is visible identically after the next poll.
5. Delete (with confirm) removes the list entry and the transcript file; deleting the
   active session lands on New session with an empty transcript.
6. All new behavior is covered by the tests in 4.4; `npm run lint:size` and existing
   CI stay green.
