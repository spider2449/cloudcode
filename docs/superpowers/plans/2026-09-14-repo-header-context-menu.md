# Repo Header Right-Click Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-clicking a multi-repo workspace repo header shows an extensible context menu whose first item opens a new session scoped to that repo.

**Architecture:** Pure menu-model helpers in a new renderer module (node-testable, same pattern as `themeMenu.tsx:moveHighlight`), a thin presentational `RepoContextMenu` component driven by an `items[]` array, and a 15-line wiring in `src.tsx` reusing the existing `selectSession` path. No backend or IPC changes.

**Tech Stack:** React 19 + TypeScript (strict), Vite renderer, Vitest (node env), existing sidebar CSS tokens.

**Spec:** `docs/superpowers/specs/2026-09-14-repo-header-context-menu-design.md`

---

## File structure

- New: `src/desktop/renderer/repoContextMenu.tsx` — owns `RepoMenuItem`, `buildRepoMenuItems()`, `clampMenuPosition()`, and the `RepoContextMenu` component. One responsibility: repo context menu model + view. Follows the `themeMenu.tsx` precedent (pure helpers + component in one file, ~90 lines).
- Modify: `src/desktop/renderer/src.tsx:468` — adds `contextMenu` state, `onContextMenu` on each `.repo-header` button, renders the menu. Left-click `onClick` untouched.
- Modify: `src/desktop/renderer/style.css` — appends `.repo-context-menu` rules reusing `--gui-element` / `--gui-hover` tokens.
- Test: `tests/desktop-repoContextMenu.test.ts` — covers the pure helpers only (no DOM needed, matches existing `tests/desktop-chatHelpers.test.ts` style).

---

### Task 1: Pure menu model + failing tests

**Files:**
- Create: `tests/desktop-repoContextMenu.test.ts`
- Create: `src/desktop/renderer/repoContextMenu.tsx` (helpers only in this task)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { buildRepoMenuItems, clampMenuPosition } from "../src/desktop/renderer/repoContextMenu.js";

describe("repo context menu model", () => {
  it("builds a single new-session item labeled with the repo name", () => {
    expect(buildRepoMenuItems("api")).toEqual([
      { id: "new-session", label: "New session in api" },
    ]);
  });
  it("keeps coordinates when far from the viewport edge", () => {
    expect(clampMenuPosition(100, 120, 1000, 800, 200, 120)).toEqual({ left: 100, top: 120 });
  });
  it("flips inside the viewport when near the right/bottom edge", () => {
    expect(clampMenuPosition(900, 750, 1000, 800, 200, 120)).toEqual({ left: 700, top: 630 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-repoContextMenu.test.ts`
Expected: FAIL with "Failed to resolve import ... repoContextMenu.js" (file does not exist yet).

- [ ] **Step 3: Write minimal helpers (no JSX yet)**

```typescript
export interface RepoMenuItem {
  id: string;
  label: string;
}

// v1 has one entry; future entries (copy path, collapse) are appended here
// so the component and wiring never change.
export function buildRepoMenuItems(repoName: string): RepoMenuItem[] {
  return [{ id: "new-session", label: `New session in ${repoName}` }];
}

// Keep the fixed-position menu inside the viewport by flipping left/up when
// the cursor is within one menu size of the edge.
export function clampMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 200,
  menuHeight = 120,
): { left: number; top: number } {
  const left = x + menuWidth > viewportWidth ? Math.max(0, x - menuWidth) : x;
  const top = y + menuHeight > viewportHeight ? Math.max(0, y - menuHeight) : y;
  return { left, top };
}
```

File: `src/desktop/renderer/repoContextMenu.tsx` containing only the code above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-repoContextMenu.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/desktop/renderer/repoContextMenu.tsx tests/desktop-repoContextMenu.test.ts
git commit -m "Add repo menu model with viewport clamping (0.1.137)"
```

Note: bump `VERSION` in `src/version.ts`, `package.json`, both `package-lock.json` version fields, and `installer/cloudcode.iss` from 0.1.136 to 0.1.137 in the same commit per AGENTS.md versioning rule.

---

### Task 2: Presentational menu component (items-driven for growth)

**Files:**
- Modify: `src/desktop/renderer/repoContextMenu.tsx`
- Test: `tests/desktop-repoContextMenu.test.ts` (no new cases; component is thin)

- [ ] **Step 1: Append the component to `repoContextMenu.tsx`**

```tsx
import { useEffect, useRef } from "react";

// (keep the RepoMenuItem / buildRepoMenuItems / clampMenuPosition code from Task 1 above this line)

export function RepoContextMenu(props: {
  x: number;
  y: number;
  repoName: string;
  items: RepoMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pos = clampMenuPosition(props.x, props.y, window.innerWidth, window.innerHeight);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) props.onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    const onScroll = (): void => props.onClose();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [props]);
  return (
    <div ref={rootRef} className="repo-context-menu" role="menu" aria-label={`Actions for ${props.repoName}`} style={{ left: pos.left, top: pos.top }}>
      {props.items.map(item => (
        <button key={item.id} role="menuitem" onClick={() => props.onSelect(item.id)}>
          <span>＋</span> {item.label}
        </button>
      ))}
    </div>
  );
}
```

All comments in English per AGENTS.md. `items`-driven: adding a future entry means passing a longer array, no component change.

- [ ] **Step 2: Typecheck the renderer**

Run: `npm run typecheck:desktop`
Expected: no errors.

- [ ] **Step 3: Re-run the unit test (helpers untouched)**

Run: `npx vitest run tests/desktop-repoContextMenu.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 4: Commit**

```bash
git add src/desktop/renderer/repoContextMenu.tsx
git commit -m "Add items-driven RepoContextMenu component (0.1.138)"
```

Note: bump patch version 0.1.137 to 0.1.138 in the same 4 version locations.

---

### Task 3: Wire right-click in `src.tsx` (left-click untouched)

**Files:**
- Modify: `src/desktop/renderer/src.tsx`
- Modify: `src/desktop/renderer/repoContextMenu.tsx` (import only, no logic change)

Exact anchor: the multi-repo branch at `src.tsx:468` rendering `button.repo-header` inside `groupSessionsByRepo(...).map(...)`.

- [ ] **Step 1: Add state + handlers in `App()`**

Add import at the top with the other renderer imports:

```typescript
import { buildRepoMenuItems, RepoContextMenu } from "./repoContextMenu.js";
```

Add state next to the other `useState` declarations (near `src.tsx:83`):

```typescript
const [contextMenu, setContextMenu] = useState<{ workspaceId: string; repoId: string; repoName: string; x: number; y: number } | null>(null);
```

Replace the repo-header button JSX (the single line starting `<button className={\`repo-header...`) with:

```tsx
<button className={`repo-header${active !== undefined && newSessionTargetFor(active) === group.repoId ? " active" : ""}`} title={`New sessions open in ${group.repoName}${group.repoPath ? ` (${group.repoPath})` : ""} — click to switch`} onClick={() => activeWorkspace && setActiveRepos(current => ({ ...current, [activeWorkspace.id]: group.repoId }))} onContextMenu={event => { event.preventDefault(); setContextMenu({ workspaceId: activeWorkspace!.id, repoId: group.repoId, repoName: group.repoName, x: event.clientX, y: event.clientY }); }}>
```

Render the menu once, just before the closing `</main>` (after the `StatuslinePicker` block):

```tsx
{contextMenu && <RepoContextMenu x={contextMenu.x} y={contextMenu.y} repoName={contextMenu.repoName} items={buildRepoMenuItems(contextMenu.repoName)} onSelect={id => { if (id === "new-session") selectSession(contextMenu.workspaceId, undefined, contextMenu.repoId); setContextMenu(null); }} onClose={() => setContextMenu(null)} />}
```

`selectSession` is the existing function at `src.tsx:423`; this is the same call the top-left New session button makes with an explicit repo.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:desktop`
Expected: no errors.

- [ ] **Step 3: Run related unit tests**

Run: `npx vitest run tests/desktop-repoContextMenu.test.ts tests/desktop-chatHelpers.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/desktop/renderer/src.tsx
git commit -m "Wire repo header right-click to new session (0.1.139)"
```

Note: bump patch version 0.1.138 to 0.1.139 in the same 4 version locations.

---

### Task 4: Menu styling + verification

**Files:**
- Modify: `src/desktop/renderer/style.css`
- Test: existing `tests/desktop-themeCss.test.ts` pattern (add menu class assertion if that file asserts class lists)

- [ ] **Step 1: Append menu CSS at the end of `style.css`**

```css
.repo-context-menu { position: fixed; z-index: 40; display: grid; min-width: 200px; padding: 6px; border: 1px solid var(--gui-border-strong, #41454e); border-radius: 9px; background: var(--gui-element, #24272d); box-shadow: 0 14px 40px #000a; }.repo-context-menu button { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--gui-text, #d5d8dd); font-size: 12px; text-align: left; cursor: pointer; }.repo-context-menu button:hover { background: var(--gui-hover, #343840); }
```

Reuses the `.command-menu` / `.theme-menu` token pattern; `position: fixed` puts it above the sidebar so overflow never clips it.

- [ ] **Step 2: Build the desktop renderer**

Run: `npm run desktop:build`
Expected: build succeeds with no errors.

- [ ] **Step 3: Run full checks**

Run: `npm run lint && npm run lint:size && npx vitest run tests/desktop-repoContextMenu.test.ts`
Expected: oxlint clean, no file over the 1000-line fail ceiling (`repoContextMenu.tsx` ~90 lines), tests PASS.

- [ ] **Step 4: Manual check (Electron or dev server)**

1. Open a multi-repo workspace (`.code-workspace` with 2 repos).
2. Left-click a repo header → header gets `.active`, top New session button targets it (unchanged).
3. Right-click the other repo header → menu shows `＋ New session in <name>` at the cursor; browser menu does not appear.
4. Click the item → empty new session opens scoped to that repo (chat title resets to "New session").
5. Right-click then press `Escape` / click elsewhere → menu closes, no session created.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/renderer/style.css
git commit -m "Style repo context menu and verify (0.1.140)"
```

Note: bump patch version 0.1.139 to 0.1.140 in the same 4 version locations.

---

## Self-review

1. **Spec coverage:** 6.1 (menu with repo name) → Task 1 `buildRepoMenuItems` + Task 2 component + Task 3 wiring. 6.2 (parity with left-click-then-new) → Task 3 reuses `selectSession(wid, undefined, repoId)`. 6.3 (existing behavior unchanged) → Task 3 touches only `onContextMenu` + menu render; `onClick`/button/`/new` untouched. 6.4 (dismiss paths) → Task 2 listeners (outside pointerdown, Escape, scroll/blur via scroll capture). 6.5 (tests + lint:size) → Task 1 tests + Task 4 checks. Viewport flip → Task 1 `clampMenuPosition`.
2. **Placeholder scan:** no TBD/TODO; every code step shows complete file content; commands include expected output; no "similar to Task N" references.
3. **Type consistency:** `RepoMenuItem { id, label }` defined once in Task 1 and reused in Tasks 2–3; `selectSession(workspaceId, sessionId | undefined, repoId?)` signature matches `src.tsx:423`; `clampMenuPosition` return `{ left, top }` consumed as `style={{ left, top }}`.
