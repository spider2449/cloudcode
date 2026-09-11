# GUI Last-Selection Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Desktop GUI reopens on the last active project + session pair, falling back to the current first-project/first-session flow when nothing valid was remembered.

**Architecture:** Pure selection logic lives in a new renderer module (`lastSelection.ts`, no React, no `window`) covered by unit tests; `src.tsx` only wires it to `localStorage` (persist on every switch, guarded until restore completes) and to the existing `restoreProjects()` effect.

**Tech Stack:** TypeScript (strict, no `any`, no non-null assertions), vitest, React, Electron renderer `localStorage`.

**Spec:** `docs/superpowers/specs/2026-09-11-gui-last-selection-design.md`

**Conventions (do not violate):** All code comments in English. `tests/` is oxlint-checked (no unused imports). Before every git commit, bump the patch version in `src/version.ts`, `package.json`, both `package-lock.json` version fields (lines 3 and 9), and `installer/cloudcode.iss` line 2 (each task below states the exact next version; current is `0.1.71`).

---

### Task 1: lastSelection pure module + unit tests

**Files:**
- Create: `desktop/renderer/lastSelection.ts`
- Test: `tests/desktop-lastSelection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-lastSelection.test.ts` with the full content:

```ts
import { describe, expect, it } from "vitest";
import {
  LAST_SELECTION_KEY,
  loadStoredSelection,
  parseStoredSelection,
  resolveRestoredSelection,
  serializeSelection
} from "../desktop/renderer/lastSelection.js";

const workspaces = [
  { id: "w1", sessions: [{ id: "s1" }, { id: "s2" }] },
  { id: "w2", sessions: [{ id: "s3" }] }
];

describe("parseStoredSelection", () => {
  it("parses a full pair and an anonymous (null session) pair", () => {
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":"s2"}')).toEqual({ workspaceId: "w1", sessionId: "s2" });
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":null}')).toEqual({ workspaceId: "w1", sessionId: null });
  });

  it("returns undefined for missing or malformed input", () => {
    expect(parseStoredSelection(null)).toBeUndefined();
    expect(parseStoredSelection("")).toBeUndefined();
    expect(parseStoredSelection("{bad")).toBeUndefined();
    expect(parseStoredSelection("[]")).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":123,"sessionId":null}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"w1"}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"","sessionId":null}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":42}')).toBeUndefined();
  });
});

describe("loadStoredSelection", () => {
  it("parses what the reader returns and swallows reader errors", () => {
    expect(loadStoredSelection(() => '{"workspaceId":"w1","sessionId":"s1"}')).toEqual({ workspaceId: "w1", sessionId: "s1" });
    expect(loadStoredSelection(() => { throw new Error("denied"); })).toBeUndefined();
  });
});

describe("resolveRestoredSelection", () => {
  it("matches today's behavior when nothing was stored", () => {
    expect(resolveRestoredSelection(workspaces, undefined)).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("restores the remembered pair, leaving other workspaces on defaults", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w2", sessionId: "s3" })).toEqual({
      active: "w2",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("restores an anonymous selection as undefined", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w2", sessionId: null })).toEqual({
      active: "w2",
      activeSessions: { w1: "s1", w2: undefined }
    });
  });

  it("falls back when the workspace or session is gone", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "gone", sessionId: "s1" })).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w1", sessionId: "deleted" })).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("handles an empty workspace list", () => {
    expect(resolveRestoredSelection([], undefined)).toEqual({ active: undefined, activeSessions: {} });
    expect(resolveRestoredSelection([], { workspaceId: "w1", sessionId: "s1" })).toEqual({ active: undefined, activeSessions: {} });
  });
});

describe("serializeSelection", () => {
  it("round-trips through parse, including the nothing-open case", () => {
    expect(parseStoredSelection(serializeSelection("w1", { w1: "s2" }))).toEqual({ workspaceId: "w1", sessionId: "s2" });
    expect(parseStoredSelection(serializeSelection("w1", {}))).toEqual({ workspaceId: "w1", sessionId: null });
    expect(parseStoredSelection(serializeSelection(undefined, {}))).toBeUndefined();
  });

  it("uses the documented storage key", () => {
    expect(LAST_SELECTION_KEY).toBe("cloudcode.lastSelection");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-lastSelection.test.ts`
Expected: FAIL with resolve/import error (`Failed to resolve import "../desktop/renderer/lastSelection.js"`).

- [ ] **Step 3: Write minimal implementation**

Create `desktop/renderer/lastSelection.ts` with the full content:

```ts
// Persists the GUI's last active project + session pair so a relaunch can
// resume where the user left off. Pure functions only (no React, no window)
// so the node-based unit tests can import this module directly.

// A null sessionId means the workspace was left on an anonymous New session.
export interface StoredSelection {
  workspaceId: string;
  sessionId: string | null;
}

// Structural minimum of the renderer's Workspace type.
export interface RestorableWorkspace {
  id: string;
  sessions: Array<{ id: string }>;
}

export const LAST_SELECTION_KEY = "cloudcode.lastSelection";

// Parses a stored value; anything missing or malformed yields undefined so
// the caller falls back to the default first-project/first-session flow.
export function parseStoredSelection(raw: string | null): StoredSelection | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { workspaceId, sessionId } = parsed as Record<string, unknown>;
    if (typeof workspaceId !== "string" || workspaceId === "") return undefined;
    if (sessionId !== null && typeof sessionId !== "string") return undefined;
    return { workspaceId, sessionId };
  } catch {
    return undefined;
  }
}

// Reads through an injected getter so storage failures (private mode, quota)
// stay the caller's concern; any failure yields undefined (default flow).
export function loadStoredSelection(read: () => string | null): StoredSelection | undefined {
  try {
    return parseStoredSelection(read());
  } catch {
    return undefined;
  }
}

// Picks the launch selection: today's defaults everywhere, except the
// remembered workspace (when it still exists) opens its remembered session —
// null for an anonymous New session, or the first session when the remembered
// one is gone.
export function resolveRestoredSelection<W extends RestorableWorkspace>(
  workspaces: W[],
  stored: StoredSelection | undefined
): { active: string | undefined; activeSessions: Record<string, string | undefined> } {
  const activeSessions: Record<string, string | undefined> = Object.fromEntries(
    workspaces.map(workspace => [workspace.id, workspace.sessions[0]?.id])
  );
  const target = (stored && workspaces.find(workspace => workspace.id === stored.workspaceId)) ?? workspaces[0];
  if (!target) return { active: undefined, activeSessions };
  if (stored && target.id === stored.workspaceId) {
    activeSessions[target.id] =
      stored.sessionId === null || target.sessions.some(session => session.id === stored.sessionId)
        ? stored.sessionId ?? undefined
        : target.sessions[0]?.id;
  }
  return { active: target.id, activeSessions };
}

// Serializes the live selection; unknown/anonymous sessions become null so a
// later parse either restores them or falls back to the default flow.
export function serializeSelection(
  active: string | undefined,
  activeSessions: Record<string, string | undefined>
): string {
  return JSON.stringify({
    workspaceId: active ?? null,
    sessionId: active ? (activeSessions[active] ?? null) : null
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-lastSelection.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit (version 0.1.72)**

Bump `0.1.71` to `0.1.72` in `src/version.ts`, `package.json`, both `package-lock.json` version fields (lines 3 and 9), `installer/cloudcode.iss` line 2. Then:

```bash
git add desktop/renderer/lastSelection.ts tests/desktop-lastSelection.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add last-selection restore helpers and tests (0.1.72)"
```

---

### Task 2: Wire restore + persist into src.tsx

**Files:**
- Modify: `desktop/renderer/src.tsx` (import, restore effect, new persist effect + guard ref)

No new unit test is possible here (the `App` component has no jsdom harness; vitest environment is node). Verification is `npm run desktop:build` (tsc over `src/` plus vite over the renderer) plus the Task 1 tests.

- [ ] **Step 1: Add the import**

In `desktop/renderer/src.tsx`, after the existing line `import { ChatPane } from "./chatPane.js";` (line 5), insert:

```tsx
import { LAST_SELECTION_KEY, loadStoredSelection, resolveRestoredSelection, serializeSelection } from "./lastSelection.js";
```

- [ ] **Step 2: Guard the persist until restore completes**

After the `lastChat` ref declaration (line 84: `const lastChat = useRef<ChatRequest | undefined>(undefined);`), insert:

```tsx
  // Set once the initial restore resolves; the persist effect below must not
  // run before that, or a slow restore would clobber the remembered value.
  const restoredRef = useRef(false);
```

- [ ] **Step 3: Use the resolver in the restore effect**

Replace the restore effect (lines 97-103):

```tsx
  useEffect(() => {
    void window.cloudcode.restoreProjects().then(restored => {
      setWorkspaces(restored);
      setActive(restored[0]?.id);
      setActiveSessions(Object.fromEntries(restored.map(workspace => [workspace.id, workspace.sessions[0]?.id])));
    });
  }, []);
```

with:

```tsx
  useEffect(() => {
    void window.cloudcode.restoreProjects().then(restored => {
      setWorkspaces(restored);
      restoredRef.current = true;
      const resolved = resolveRestoredSelection(
        restored,
        loadStoredSelection(() => window.localStorage.getItem(LAST_SELECTION_KEY))
      );
      setActive(resolved.active);
      setActiveSessions(resolved.activeSessions);
    });
  }, []);
```

- [ ] **Step 4: Add the persist effect**

After the restore effect (after line 103, before the `useEffect` that starts with `if (!active) return;`), insert:

```tsx
  // Remembers the last active pair on every switch (crash-safe). Failures are
  // ignored so the next launch simply falls back to the default selection.
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      window.localStorage.setItem(LAST_SELECTION_KEY, serializeSelection(active, activeSessions));
    } catch {
      // Storage unavailable: keep the previously stored value, if any.
    }
  }, [active, activeSessions]);
```

- [ ] **Step 5: Verify with tests and build**

Run: `npx vitest run tests/desktop-lastSelection.test.ts tests/desktop-chatPane.test.ts`
Expected: PASS.

Run: `npm run desktop:build`
Expected: `tsc` clean, vite emits `desktop/dist/*` with no errors (only the pre-existing `node:` externalized warnings from `chatPane.tsx`'s registry import).

- [ ] **Step 6: Commit (version 0.1.73)**

Bump `0.1.72` to `0.1.73` in the same four places. Then:

```bash
git add desktop/renderer/src.tsx src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Restore last GUI project+session on launch (0.1.73)"
```

---

### Task 3: Full verification and acceptance

No code changes. No commit (no version bump without a commit).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS (no failures; the pre-existing skips remain).

- [ ] **Step 2: Run linters**

Run: `npm run lint`
Expected: only pre-existing warnings in files this plan does not touch.

Run: `npm run lint:size`
Expected: only the four pre-existing warnings; no failures.

- [ ] **Step 3: Manual smoke (Desktop, requires display)**

Run `npm run desktop:start`, then verify spec acceptance criteria 1-4: quit on a named session and relaunch (lands back with transcript); quit on New session (lands on empty New session); delete the remembered session / corrupt `cloudcode.lastSelection` / fresh profile (original flow, no errors).

- [ ] **Step 4: Report**

Summarize pass/fail per acceptance criterion (spec section 6, items 1-5) with evidence (test names / build output / manual observations).
