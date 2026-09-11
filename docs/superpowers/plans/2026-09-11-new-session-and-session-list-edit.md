# /new Parity + Session List Rename/Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop `/new` behave exactly like the New Session button, unify `/clear` with `/new`, and add hover rename/delete to the Desktop sessions sidebar.

**Architecture:** Backend emits a `new_session` chat event that reuses the button's `selectSession(id, undefined)` path; persistence gains `SessionIndex.rename/remove` and `SessionFile.delete` behind workspace-checked `DesktopShellHost` methods exposed over two new IPC channels.

**Tech Stack:** TypeScript (strict), vitest, Electron IPC (main/preload), React renderer (vite build).

**Spec:** `docs/superpowers/specs/2026-09-11-new-session-and-session-list-edit-design.md`

**Conventions (do not violate):** All code comments in English. `npm run lint:size` must stay clean (600-line warn / 1000-line fail; `src/cli.tsx` and `src/ui/nativeApp.ts` already warn — do not grow them further). Before every git commit, bump the patch version in `src/version.ts`, `package.json`, both `package-lock.json` version fields, and `installer/cloudcode.iss` (each task below states the exact next version).

---

### Task 1: SessionIndex.rename/remove

**Files:**
- Modify: `src/agent/sessionIndex.ts` (append two methods after `touch`, ~lines 43-51)
- Test: `tests/sessionIndex.test.ts` (append new describe block)

- [ ] **Step 1: Write the failing test**

Append to `tests/sessionIndex.test.ts`:

```ts
describe("SessionIndex.rename/remove", () => {
  it("renames the title and bumps recency", async () => {
    const index = new SessionIndex(tempFile());
    index.record({ id: "old", cwd: "/p", firstMessage: "old", timestamp: "2000-01-01T00:00:00.000Z", provider: "anthropic" });
    index.record({ id: "new", cwd: "/p", firstMessage: "new", timestamp: "2000-01-02T00:00:00.000Z", provider: "anthropic" });
    await new Promise(resolve => setTimeout(resolve, 5));
    index.rename("old", "  renamed  ");
    const list = index.list();
    expect(list[0].id).toBe("old");
    expect(list[0].firstMessage).toBe("renamed");
  });

  it("ignores blank titles and unknown ids", () => {
    const index = new SessionIndex(tempFile());
    index.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2000-01-01T00:00:00.000Z", provider: "anthropic" });
    index.rename("s1", "   ");
    index.rename("missing", "x");
    expect(index.list()[0].firstMessage).toBe("hi");
  });

  it("removes entries and persists the removal", () => {
    const file = tempFile();
    const index = new SessionIndex(file);
    index.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2000-01-01T00:00:00.000Z", provider: "anthropic" });
    index.remove("s1");
    expect(index.list()).toEqual([]);
    expect(new SessionIndex(file).list()).toEqual([]);
  });

  it("remove ignores unknown ids instead of throwing", () => {
    const index = new SessionIndex(tempFile());
    expect(() => index.remove("missing")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sessionIndex.test.ts`
Expected: FAIL with `index.rename is not a function` (4 tests fail, existing 5 pass).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/sessionIndex.ts`, insert after the `touch` method (after line 51, before `latestForCwd`):

```ts
  /** Rename a session's display title and bump it to most-recent. Blank titles and unknown ids are ignored. */
  rename(id: string, firstMessage: string): void {
    const title = firstMessage.trim().slice(0, 200);
    if (!title) return;
    this.reload();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.firstMessage = title;
    entry.timestamp = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  /** Drop a session entry. Unknown ids are ignored, mirroring touch(). */
  remove(id: string): void {
    this.reload();
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length === before) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }
```

No new imports needed (`mkdirSync`, `dirname`, `writeFileSync` already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sessionIndex.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit (version 0.1.64)**

Bump `0.1.63` to `0.1.64` in `src/version.ts`, `package.json`, both `package-lock.json` version fields (lines 3 and 9), `installer/cloudcode.iss` line 2. Then:

```bash
git add src/agent/sessionIndex.ts tests/sessionIndex.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add SessionIndex rename/remove (0.1.64)"
```

---

### Task 2: SessionFile.delete

**Files:**
- Modify: `src/engine/sessions.ts`
- Test: `tests/engine-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-sessions.test.ts` inside the existing `describe("SessionFile", ...)` block:

```ts
  it("delete() removes the transcript file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess6-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "hi" });
    SessionFile.delete("abc", dir);
    expect(SessionFile.load("abc", dir)).toEqual([]);
  });

  it("delete() ignores missing files instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess7-"));
    expect(() => SessionFile.delete("missing", dir)).not.toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-sessions.test.ts`
Expected: FAIL with `SessionFile.delete is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/sessions.ts`, change the import line to include `rmSync`:

```ts
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

Add inside the class after `rewrite`:

```ts
  // Deletes the transcript file. Missing files are not errors, so removing
  // an index entry never fails when its transcript is already gone.
  static delete(sessionId: string, dir: string = defaultDir()): void {
    try {
      rmSync(join(dir, `${sessionId}.jsonl`), { force: true });
    } catch {
      // Undeletable file: the index entry is the source of truth, ignore.
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-sessions.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit (version 0.1.65)**

Bump `0.1.64` to `0.1.65` in the same four places. Then:

```bash
git add src/engine/sessions.ts tests/engine-sessions.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add SessionFile.delete (0.1.65)"
```

---

### Task 3: new_session chat event vocabulary

**Files:**
- Modify: `src/desktop/chatProtocol.ts:10`
- Test: `tests/desktop-chatProtocol.test.ts:15`

- [ ] **Step 1: Update the failing test**

In `tests/desktop-chatProtocol.test.ts`, change the vocabulary assertion to:

```ts
    expect(CHAT_EVENT_TYPES).toEqual(["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "complete", "new_session", "done"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: FAIL, expected array missing `"new_session"`.

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/chatProtocol.ts` line 10, change to:

```ts
export const CHAT_EVENT_TYPES = ["text_delta", "tool_use", "tool_result", "notice", "error", "permission_request", "user_text", "complete", "new_session", "done"] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-chatProtocol.test.ts`
Expected: PASS, 5 tests. Also run: `npx vitest run tests/desktop-chatEvents.test.ts tests/desktop-chatHistory.test.ts tests/desktop-guiServer.test.ts`
Expected: PASS (no other vocabulary snapshots exist).

- [ ] **Step 5: Commit (version 0.1.66)**

Bump `0.1.65` to `0.1.66` in the same four places. Then:

```bash
git add src/desktop/chatProtocol.ts tests/desktop-chatProtocol.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add new_session chat event type (0.1.66)"
```

---

### Task 4: GUI clearSession requests new session + /clear unifies with /new

**Files:**
- Modify: `src/desktop/guiCommandContext.ts` (interface + clearSession)
- Modify: `src/commands/builtins.ts:189-193` (`/clear`), `:271-275` (`/new` description)
- Test: `tests/desktop-guiCommandContext.test.ts` (setup deps + new test)

- [ ] **Step 1: Write the failing test**

In `tests/desktop-guiCommandContext.test.ts`, in `setup()`, add a `newSessionRequests` array and the new dep. Change:

```ts
function setup() {
  const notices: string[] = [];
```

to:

```ts
function setup() {
  const notices: string[] = [];
  const newSessionRequests: string[] = [];
```

In the `deps` object literal, after the `restartSession` field (lines 57-60), add:

```ts
    requestNewSession: () => { newSessionRequests.push("new"); },
```

And change the return to include it:

```ts
  return { notices, errors, session, slash, ctx, newSessionRequests };
```

Append a new test inside the top-level describe:

```ts
  it("/new restarts the backend session and requests a fresh anonymous session", async () => {
    const { errors, slash, newSessionRequests } = setup();
    await slash("/new");
    expect(errors).toEqual([]);
    expect(newSessionRequests).toEqual(["new"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-guiCommandContext.test.ts`
Expected: FAIL — TypeScript error `requestNewSession` does not exist in `GuiCommandDeps` (vitest/esbuild surfaces it as a transform or type error), or the new test fails because nothing calls it.

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/guiCommandContext.ts`, in `GuiCommandDeps` after the `restartSession` line (line 55), add:

```ts
  // Switches the GUI shell to a fresh anonymous session (the New Session
  // button path). Invoked by /new and /clear so slash and button stay identical.
  requestNewSession(): void;
```

Replace `clearSession` (lines 74-77):

```ts
    clearSession: async () => {
      await deps.restartSession();
      deps.requestNewSession();
    },
```

In `src/commands/builtins.ts`, replace the `/clear` command (lines 189-193):

```ts
  {
    name: "clear",
    description: "Start a new session",
    async run(ctx) { await ctx.clearSession(); }
  },
```

And change the `/new` description (line 273) from `"Start a new session and show the welcome screen"` to `"Start a new session"`.

No other test updates needed: `tests/commands.test.ts` only asserts `clearSession` was called for `/new`, and no test asserts the removed `"Started a new session."` notice (verified by grep).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/desktop-guiCommandContext.test.ts tests/commands.test.ts tests/app.test.ts`
Expected: PASS (6 + all commands + all app tests; app.test.ts `/new` transcript-clearing tests unaffected since TUI `clearSession` is untouched).

- [ ] **Step 5: Commit (version 0.1.67)**

Bump `0.1.66` to `0.1.67` in the same four places. Then:

```bash
git add src/desktop/guiCommandContext.ts src/commands/builtins.ts tests/desktop-guiCommandContext.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Unify /clear with /new; GUI clearSession requests new session (0.1.67)"
```

---

### Task 5: Wire requestNewSession to the new_session event in cli.tsx

**Files:**
- Modify: `src/cli.tsx` (inside `buildContext`, after `restartSession` at lines 204-208)

This file has no direct unit harness (top-level side-effect module); coverage comes from Task 4 plus typecheck.

- [ ] **Step 1: Write the implementation (no failing test possible here)**

In `src/cli.tsx`, after:

```ts
      restartSession: async provider => {
        if (provider) state.providerName = provider;
        await disposeKey(key);
        return getSession(key, state);
      },
```

insert:

```ts
      requestNewSession: () => {
        emit({ id, type: "new_session" });
      },
```

`emit` (line 69) and `id` (the `buildContext(req)` closure parameter) are both in scope; the pattern matches the existing `notice: text => emit({ id, type: "notice", text })` line directly above.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean, no errors.

- [ ] **Step 3: Run related GUI backend tests**

Run: `npx vitest run tests/desktop-guiServer.test.ts tests/desktop-guiCommandContext.test.ts tests/desktop-sessionRecord.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit (version 0.1.68)**

Bump `0.1.67` to `0.1.68` in the same four places. Then:

```bash
git add src/cli.tsx src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Emit new_session event for GUI /new and /clear (0.1.68)"
```

---

### Task 6: ShellHost rename/remove + IPC bridge

**Files:**
- Modify: `src/desktop/shellHost.ts` (import, option, two methods)
- Modify: `desktop/main.mjs` (two handlers after the `chat-complete` handler, ~line 188)
- Modify: `desktop/preload.cjs` (two bridge lines)
- Test: `tests/desktop-shellHost.test.ts` (three new tests)

- [ ] **Step 1: Write the failing test**

In `tests/desktop-shellHost.test.ts`, update the import line to:

```ts
import { SessionFile } from "../src/engine/sessions.js";
```

Append inside `describe("DesktopShellHost", ...)`:

```ts
  it("renames a session title within its workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: project, firstMessage: "Old", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(project);

    const updated = host.renameSession(workspace.id, "s1", "  New title  ");
    expect(updated.sessions).toEqual([expect.objectContaining({ id: "s1", firstMessage: "New title" })]);
  });

  it("rejects renaming a session from another workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "right-session", cwd: right, firstMessage: "Right", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(left);

    expect(() => host.renameSession(workspace.id, "right-session", "x")).toThrow("does not belong");
  });

  it("removes the index entry and the transcript file", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const sessionDir = join(root, "transcripts");
    mkdirSync(sessionDir);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: project, firstMessage: "Gone", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    new SessionFile("s1", sessionDir).append({ role: "user", content: "hi" });
    const host = new DesktopShellHost({ sessionIndex: index, sessionDir, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(project);

    const updated = host.removeSession(workspace.id, "s1");
    expect(updated.sessions).toEqual([]);
    expect(SessionFile.load("s1", sessionDir)).toEqual([]);
    expect(index.list()).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-shellHost.test.ts`
Expected: FAIL with `host.renameSession is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/desktop/shellHost.ts`, add the import:

```ts
import { SessionFile } from "../engine/sessions.js";
```

In `DesktopShellHostOptions`, add:

```ts
  gitRunner?: GitRunner;
  // Overrides the transcript directory for SessionFile.delete (tests only).
  sessionDir?: string;
```

Add methods after `assertSession` (after line 73):

```ts
  renameSession(workspaceId: string, sessionId: string, title: string): DesktopShellWorkspace {
    this.assertSession(workspaceId, sessionId);
    this.sessionIndex.rename(sessionId, title);
    return this.describe(workspaceId);
  }

  removeSession(workspaceId: string, sessionId: string): DesktopShellWorkspace {
    this.assertSession(workspaceId, sessionId);
    this.sessionIndex.remove(sessionId);
    SessionFile.delete(sessionId, this.options.sessionDir);
    return this.describe(workspaceId);
  }
```

Note: passing `undefined` for `dir` falls back to `SessionFile`'s default directory (default parameters apply on explicit `undefined`).

In `desktop/main.mjs`, after the `chat-complete` handler block (ends line 188), insert:

```js
ipcMain.handle("cloudcode:rename-session", (_event, workspaceId, sessionId, title) => host.renameSession(requireString(workspaceId, "workspace ID"), requireString(sessionId, "session ID"), requireString(title, "session title")));
ipcMain.handle("cloudcode:remove-session", (_event, workspaceId, sessionId) => host.removeSession(requireString(workspaceId, "workspace ID"), requireString(sessionId, "session ID")));
```

`requireString` is already imported in `main.mjs` line 7. Empty titles throw there; the renderer additionally guards empties before sending.

In `desktop/preload.cjs`, after the `chatComplete` line, insert:

```js
  renameSession: (workspaceId, sessionId, title) => ipcRenderer.invoke("cloudcode:rename-session", workspaceId, sessionId, title),
  removeSession: (workspaceId, sessionId) => ipcRenderer.invoke("cloudcode:remove-session", workspaceId, sessionId),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-shellHost.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit (version 0.1.69)**

Bump `0.1.68` to `0.1.69` in the same four places. Then:

```bash
git add src/desktop/shellHost.ts desktop/main.mjs desktop/preload.cjs tests/desktop-shellHost.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add session rename/remove host methods and IPC bridge (0.1.69)"
```

---

### Task 7: Renderer — new_session handling + hover rename/delete UI

**Files:**
- Modify: `desktop/renderer/chatPane.tsx` (prop, ref, event branch, pure helper)
- Modify: `desktop/renderer/src.tsx` (window type, state, two functions, session list JSX, ChatPane prop)
- Modify: `desktop/renderer/style.css` (append one rule line)
- Test: `tests/desktop-chatPane.test.ts` (helper test)

The React component wiring has no jsdom harness (vitest environment is node; existing chatPane tests cover only pure helpers), so component logic is verified by `npm run desktop:build` (vite) plus manual smoke.

- [ ] **Step 1: Write the failing test**

In `tests/desktop-chatPane.test.ts`, change the import to:

```ts
import { applySuggestionText, describeSlashInput, isNewSessionEvent } from "../desktop/renderer/chatPane.js";
```

Append:

```ts
describe("new session events", () => {
  it("recognizes the backend new-session signal", () => {
    expect(isNewSessionEvent({ type: "new_session" })).toBe(true);
    expect(isNewSessionEvent({ type: "done" })).toBe(false);
    expect(isNewSessionEvent({ type: "notice" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatPane.test.ts`
Expected: FAIL with `isNewSessionEvent is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation (chatPane.tsx)**

Add the pure helper next to `describeSlashInput` (after line 42):

```tsx
// True when the backend asks the shell to start a fresh anonymous session
// (GUI /new and /clear emit this; the shell handles it like the New Session button).
export function isNewSessionEvent(event: { type: string }): boolean {
  return event.type === "new_session";
}
```

Change the `ChatPane` signature:

```tsx
export function ChatPane({ workspaceId, sessionId, onSend, onRequestNewSession }: { workspaceId: string | undefined; sessionId: string | undefined; onSend?: (request: { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined }) => void; onRequestNewSession?: (workspaceId: string | undefined) => void }) {
```

After the `nestedOnce` ref declaration (line 60), add:

```tsx
  // Latest new-session callback; stored in a ref so the chat-event
  // subscription below never goes stale when the parent re-renders.
  const newSessionRef = useRef(onRequestNewSession);
  newSessionRef.current = onRequestNewSession;
```

In the `onChatEvent` callback inside the session-switch `useEffect`, before the `if (event.type === "complete")` branch (line 72), add:

```tsx
      if (isNewSessionEvent(event)) {
        newSessionRef.current?.(workspaceId);
        return;
      }
```

- [ ] **Step 4: Write the src.tsx changes**

In the `window.cloudcode` type declaration, after the `chatComplete` line (line 39), add:

```ts
      renameSession(workspaceId: string, sessionId: string, title: string): Promise<Workspace>;
      removeSession(workspaceId: string, sessionId: string): Promise<Workspace>;
```

After the `activeSessions` state declaration (line 71), add:

```tsx
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
```

After `selectSession` (lines 221-224), add:

```tsx
  async function submitRename(workspaceId: string, sessionId: string, title: string) {
    const trimmed = title.trim().slice(0, 200);
    setEditingId(undefined);
    if (!trimmed) return;
    const workspace = await window.cloudcode.renameSession(workspaceId, sessionId, trimmed);
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
  }

  async function deleteSession(workspaceId: string, sessionId: string) {
    if (!window.confirm("Delete this session? This removes it from the list and deletes its transcript.")) return;
    const workspace = await window.cloudcode.removeSession(workspaceId, sessionId);
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
    setActiveSessions(current => {
      if (current[workspaceId] !== sessionId) return current;
      return { ...current, [workspaceId]: undefined };
    });
  }
```

Replace the session list `<nav>` (line 239):

```tsx
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.sessions.map(session => <button key={session.id} className={activeSessions[activeWorkspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(activeWorkspace.id, session.id)}><span className="session-title">{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button>)}{activeWorkspace && activeWorkspace.sessions.length === 0 && <p className="no-sessions">Your first message will name this session.</p>}</nav>
```

with:

```tsx
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.sessions.map(session => <div key={session.id} className="session-item">{editingId === session.id ? <input className="session-edit-input" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submitRename(activeWorkspace.id, session.id, draft); else if (event.key === "Escape") setEditingId(undefined); }} onBlur={() => void submitRename(activeWorkspace.id, session.id, draft)} aria-label="Rename session" /> : <><button className={activeSessions[activeWorkspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(activeWorkspace.id, session.id)}><span className="session-title">{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button><span className="session-actions"><button title="Rename session" aria-label={`Rename ${session.firstMessage || "Untitled session"}`} onClick={() => { setEditingId(session.id); setDraft(session.firstMessage); }}>✎</button><button title="Delete session" aria-label={`Delete ${session.firstMessage || "Untitled session"}`} onClick={() => void deleteSession(activeWorkspace.id, session.id)}>🗑</button></span>}</div>)}{activeWorkspace && activeWorkspace.sessions.length === 0 && <p className="no-sessions">Your first message will name this session.</p>}</nav>
```

Update the `ChatPane` element (line 244) from:

```tsx
<ChatPane workspaceId={active} sessionId={activeSessions[active ?? ""]} onSend={request => { lastChat.current = request; }} />
```

to:

```tsx
<ChatPane workspaceId={active} sessionId={activeSessions[active ?? ""]} onSend={request => { lastChat.current = request; }} onRequestNewSession={workspaceId => { if (workspaceId) selectSession(workspaceId, undefined); }} />
```

- [ ] **Step 5: Write the style.css addition**

Append as line 40 of `desktop/renderer/style.css` (single-line rule, matching file style):

```css
.session-item { position: relative; }.session-item .session-card { width: 100%; }.session-actions { position: absolute; right: 6px; top: 6px; display: none; gap: 2px; }.session-item:hover .session-actions, .session-item:focus-within .session-actions { display: flex; }.session-actions button { padding: 2px 5px; border: 0; border-radius: 4px; background: #22252a; color: #858b96; font-size: 10px; cursor: pointer; }.session-actions button:hover { background: #2a2e35; color: #d5d8de; }.session-edit-input { width: 100%; padding: 8px 10px; border: 1px solid #41454e; border-radius: 7px; background: #1d2025; color: #d8dbe1; font-size: 12px; outline: 0; }
```

- [ ] **Step 6: Run tests and build**

Run: `npx vitest run tests/desktop-chatPane.test.ts`
Expected: PASS, 8 tests.

Run: `npm run desktop:build`
Expected: `tsc` build clean, vite build emits `desktop/dist/index.html` with no errors.

- [ ] **Step 7: Commit (version 0.1.70)**

Bump `0.1.69` to `0.1.70` in the same four places. Then:

```bash
git add desktop/renderer/chatPane.tsx desktop/renderer/src.tsx desktop/renderer/style.css tests/desktop-chatPane.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add renderer new_session handling and session rename/delete UI (0.1.70)"
```

---

### Task 8: Full verification and acceptance

No code changes. No commit (no version bump without a commit).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 2: Run linters**

Run: `npm run lint`
Expected: clean.

Run: `npm run lint:size`
Expected: only the four pre-existing warnings (`src/ui/nativeApp.ts`, `src/cli.tsx`, `tests/commands.test.ts`, `tests/render.test.ts`); no new files over limits, no failures.

- [ ] **Step 3: Manual smoke (Desktop)**

Run: `npm run desktop:start`, then verify acceptance criteria 1, 3, 4, 5 from the spec section 6 (type `/new` in a named session; hover ✎/🗑; rename persists after restart; delete with confirm removes entry and transcript, deleting the active session lands on New session). This step requires a display and LLM credentials; if unavailable, note it in the final report instead of blocking.

- [ ] **Step 4: Report**

Summarize pass/fail per acceptance criterion (spec section 6, items 1-6) with evidence (test names / build output).
