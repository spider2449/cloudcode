# GUI Busy Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an animated `Thinking....` status in the desktop GUI while the LLM is working, and disable Send to prevent duplicate submits.

**Architecture:** Pure `busyLabel()` helper in `desktop/renderer/chatPane.tsx` (tested like the existing pure helpers) drives a conditional `<span>` with a CSS dot animation; the existing `pendingIds` state is the single source of truth, so no protocol change is needed.

**Tech Stack:** React JSX in `desktop/renderer/chatPane.tsx`, CSS in `desktop/renderer/style.css`, vitest (`npm test`).

---

### Task 1: `busyLabel()` helper plus unit test

**Files:**
- Modify: `desktop/renderer/chatPane.tsx` (append helper after `parseSessionIdEvent`, before `ChatPane`)
- Modify: `tests/desktop-chatPane.test.ts` (extend import, append describe block)

- [ ] **Step 1: Write the failing test**

In `tests/desktop-chatPane.test.ts`, change line 2 to:

```ts
import { applySuggestionText, busyLabel, describeSlashInput, isNewSessionEvent, parseSessionIdEvent } from "../desktop/renderer/chatPane.js";
```

Append at end of file:

```ts
describe("busy label", () => {
  it("shows Thinking while turns are in flight, nothing when idle", () => {
    expect(busyLabel(0)).toBeNull();
    expect(busyLabel(1)).toBe("Thinking");
    expect(busyLabel(3)).toBe("Thinking");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-chatPane.test.ts`
Expected: FAIL with "busyLabel is not exported" (or "does not provide an export named 'busyLabel'").

- [ ] **Step 3: Write minimal implementation**

In `desktop/renderer/chatPane.tsx`, after the `parseSessionIdEvent` function (lines 53-56) and before the `ChatPane` component (line 58), insert:

```tsx
// Text status for an in-flight LLM turn. Null means idle (hide the label).
// The animated dots are a separate CSS span so this stays a pure function
// that node-based unit tests can import (same pattern as lastSelection.ts).
export function busyLabel(pendingCount: number): string | null {
  return pendingCount > 0 ? "Thinking" : null;
}
```

All code comments must be in English (repo rule).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-chatPane.test.ts`
Expected: all tests PASS (4 existing describes plus the new "busy label" block).

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/chatPane.tsx tests/desktop-chatPane.test.ts
git commit -m "Add GUI busy-label helper with test"
```

Note: the repo versioning rule (bump patch in `src/version.ts`, `package.json`, both `package-lock.json` version fields, `installer/cloudcode.iss` together) applies to each commit below. Read the current value from `src/version.ts` (0.1.77 at plan time) and bump the patch number by one per commit.

---

### Task 2: Busy label, dot animation, and Send disabled state

**Files:**
- Modify: `desktop/renderer/chatPane.tsx` (the `.chat-input` block, lines 305-319)
- Modify: `desktop/renderer/style.css` (append rules at end of file; do NOT touch the long minified line 39)

- [ ] **Step 1: Wire the busy label into the composer**

In `desktop/renderer/chatPane.tsx`, replace this block:

```tsx
      <div className="chat-input">
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Message input"
          value={input}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          placeholder="Message, or / for commands (Shift+Enter for newline)"
        />
        <button className="chat-send" onClick={send}>Send</button>
        {pendingIds.length > 0 && <button className="chat-stop" aria-label="Abort turn" onClick={() => { const last = pendingIds[pendingIds.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
```

with:

```tsx
      <div className="chat-input">
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Message input"
          value={input}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          placeholder="Message, or / for commands (Shift+Enter for newline)"
        />
        {busyLabel(pendingIds.length) !== null && (
          <span className="chat-busy" role="status">
            {busyLabel(pendingIds.length)}<span className="chat-busy-dots" aria-hidden="true" />
          </span>
        )}
        <button className="chat-send" onClick={send} disabled={pendingIds.length > 0}>Send</button>
        {pendingIds.length > 0 && <button className="chat-stop" aria-label="Abort turn" onClick={() => { const last = pendingIds[pendingIds.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
```

Behavior notes (no extra code needed): `pendingIds` gains an entry in `send()` and loses it on `done`/`error` events (`chatPane.tsx:146-148`) or local `abort()`, so the label shows/hides automatically. `role="status"` announces the busy state to screen readers; the dots span is `aria-hidden` so they hear "Thinking" once, not dot chatter.

- [ ] **Step 2: Append the animation and disabled styles**

Append exactly these rules at the end of `desktop/renderer/style.css` (new lines, after line 40):

```css
.chat-pane .chat-input .chat-busy { align-self: center; color: var(--gui-muted, #9ba1ab); font-size: 12px; white-space: nowrap; }
.chat-pane .chat-input .chat-busy-dots::after { content: ""; animation: chat-busy-dots 1.2s steps(1) infinite; }
@keyframes chat-busy-dots { 0% { content: ""; } 20% { content: "."; } 40% { content: ".."; } 60% { content: "..."; } 80%, 100% { content: "...."; } }
.chat-pane .chat-input .chat-send:disabled { opacity: .45; cursor: default; }
```

The `var(--gui-muted, #9ba1ab)` fallback keeps today's look and picks up the live-theme variables from the companion plan without rework. Discrete `content` animation works in Chromium/Electron.

- [ ] **Step 3: Run automated checks**

Run: `npx vitest run tests/desktop-chatPane.test.ts`
Expected: PASS.

Run: `npm run lint`
Expected: no errors (oxlint covers `desktop/renderer` only if configured; a pass with no new warnings is the bar).

Run: `npm run desktop:build`
Expected: `tsc` passes and `vite build` emits `desktop/dist` without errors (catches JSX/CSS import mistakes; note `tsc -p tsconfig.json` only covers `src/`, so vite is the real renderer check).

- [ ] **Step 4: Verify manually**

Run: `npm run desktop:start`, open a project, send a message. Confirm: `Thinking....` with cycling dots appears next to Stop, Send is dimmed and unclickable, and both revert when the reply completes. Then abort mid-turn with Stop and confirm the label clears and the `Cancelled.` notice still appears.

- [ ] **Step 5: Commit (with patch version bump per repo rule)**

```bash
git add desktop/renderer/chatPane.tsx desktop/renderer/style.css src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Show animated Thinking busy status in GUI composer (0.1.78)"
```

(Adjust the version number to current patch + 1; update all of `src/version.ts`, `package.json`, both `package-lock.json` version fields, and `installer/cloudcode.iss` in the same commit or `tests/packaging.test.ts` fails.)
