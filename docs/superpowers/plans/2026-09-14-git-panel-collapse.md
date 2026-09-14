# Git Panel Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SYNC / CURRENT / RECENT / STAGED CHANGES / CHANGES in the desktop Git panel independently collapsible, default fully expanded.

**Architecture:** Add a `CollapsibleSection` wrapper plus `collapsed/onToggle` props on `GitFileGroup`, with per-repo local `useState` in `GitRepoCard`. No persistence, no data-flow changes.

**Tech Stack:** React + TypeScript (Vite+Electron renderer), existing `section-heading` / `bare-button` CSS, vitest.

---

### Task 1: Collapsible helpers with tests

**Files:**
- Modify: `src/desktop/renderer/gitPanel.tsx:101-115`
- Test: `tests/desktop-gitPanel.test.ts`

File responsibility: `gitPanel.tsx` owns all Git panel rendering; helpers at the bottom own pure toggle-label logic. Test file owns helper contracts.

- [ ] **Step 1: Write the failing test**

Add to `tests/desktop-gitPanel.test.ts` (append new describe block, keep existing imports plus new ones):

```ts
import { describe, expect, it } from "vitest";
import { collapseToggleLabel, isSectionCollapsed } from "../src/desktop/renderer/gitPanel.js";

describe("section collapse helpers", () => {
  it("labels the toggle by collapsed state", () => {
    expect(collapseToggleLabel(true, "CHANGES")).toBe("Expand CHANGES");
    expect(collapseToggleLabel(false, "CHANGES")).toBe("Collapse CHANGES");
  });
  it("defaults sections to expanded", () => {
    expect(isSectionCollapsed(undefined)).toBe(false);
    expect(isSectionCollapsed(false)).toBe(false);
    expect(isSectionCollapsed(true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop-gitPanel.test.ts`
Expected: FAIL with "does not provide an export named 'collapseToggleLabel'"

- [ ] **Step 3: Write minimal implementation**

Append to `src/desktop/renderer/gitPanel.tsx` after `gitFilePaths`:

```ts
export function collapseToggleLabel(collapsed: boolean, title: string): string { return `${collapsed ? "Expand" : "Collapse"} ${title}`; }
export function isSectionCollapsed(value: boolean | undefined): boolean { return value === true; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/desktop-gitPanel.test.ts`
Expected: PASS (all 5 tests: 3 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/desktop/renderer/gitPanel.tsx tests/desktop-gitPanel.test.ts
git commit -m "feat(desktop): add collapse toggle helpers for git panel"
```

### Task 2: CollapsibleSection component + GitFileGroup collapse props

**Files:**
- Modify: `src/desktop/renderer/gitPanel.tsx:59-104`
- Test: `tests/desktop-gitPanel.test.ts` (no change, regression only)

File responsibility: `CollapsibleSection` renders header toggle + conditional children; `GitFileGroup` reuses the same header pattern for file lists.

- [ ] **Step 1: Write the failing typecheck probe**

No new test code (no RTL in repo). Instead prove the API does not exist yet:

Run: `npx tsc -p tsconfig.desktop.json --noEmit`
Expected: PASS baseline (component not yet referenced; records current green state before edit).

- [ ] **Step 2: Add CollapsibleSection + extend GitFileGroup**

Insert before `GitFileGroup` (after `GitRepoCard` closing brace, line ~99):

```tsx
type SectionId = "sync" | "current" | "recent" | "staged" | "changes";

function CollapsibleSection({ id, title, actions, collapsed, onToggle, children }: { id: SectionId; title: string; actions?: ReactNode; collapsed: boolean; onToggle(): void; children: ReactNode }) {
  return <section className={`git-${id}`}><div className="section-heading"><button className="bare-button" aria-label={collapseToggleLabel(collapsed, title)} aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "▸" : "▾"}</button><span>{title}</span>{actions}</div>{!collapsed && children}</section>;
}
```

Replace `GitFileGroup` with:

```tsx
function GitFileGroup({ title, files, status, action, disabled, collapsed, onToggle, onSelect, onAction, onAll }: { title: string; files: GitState["files"]; status: "index" | "workingTree"; action: string; disabled: boolean; collapsed?: boolean; onToggle?(): void; onSelect(file: GitFile): void; onAction(file: GitFile): void; onAll(): void }) {
  if (files.length === 0) return null;
  const isCollapsed = isSectionCollapsed(collapsed);
  const heading = onToggle
    ? <div className="section-heading"><button className="bare-button" aria-label={collapseToggleLabel(isCollapsed, title)} aria-expanded={!isCollapsed} onClick={onToggle}>{isCollapsed ? "▸" : "▾"}</button><span>{title} · {files.length}</span><button disabled={disabled} onClick={onAll}>{action} all</button></div>
    : <div className="section-heading"><span>{title} · {files.length}</span><button disabled={disabled} onClick={onAll}>{action} all</button></div>;
  if (isCollapsed) return <section className="git-group">{heading}</section>;
  return <section className="git-group">{heading}{files.map((file, index) => <div className="git-file" key={`${file.path}-${index}`}><button className="git-file-name" title={file.path} onClick={() => onSelect(file)}><span className="git-badge">{gitStatusLabel(file[status])}</span><span>{file.path}</span></button><button disabled={disabled} onClick={() => onAction(file)}>{action}</button></div>)}</section>;
}
```

Note: `ReactNode` is already imported in this file (line 1). No new CSS needed.

- [ ] **Step 3: Run typecheck + unit tests**

Run: `npx tsc -p tsconfig.desktop.json --noEmit`
Expected: PASS

Run: `npx vitest run tests/desktop-gitPanel.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/desktop/renderer/gitPanel.tsx
git commit -m "feat(desktop): collapsible section wrapper and file-group toggle"
```

### Task 3: Wire collapse state into GitRepoCard

**Files:**
- Modify: `src/desktop/renderer/gitPanel.tsx:59-98`
- Test: `tests/desktop-gitPanel.test.ts` (regression only)

File responsibility: `GitRepoCard` owns the per-repo `Record<SectionId, boolean>` collapse state (all `false` = expanded, never persisted).

- [ ] **Step 1: Add state hook**

Inside `GitRepoCard`, after `const [error, setError] = useState<string>();` (line 67) insert:

```tsx
const [collapsedSections, setCollapsedSections] = useState<Record<SectionId, boolean>>({ sync: false, current: false, recent: false, staged: false, changes: false });
const toggleSection = (id: SectionId) => setCollapsedSections(current => ({ ...current, [id]: !current[id] }));
```

- [ ] **Step 2: Replace SYNC / CURRENT / RECENT / file-group JSX**

Replace lines 89-93 (the `<section className="git-sync">`, `<section className="git-current">`, `<section className="git-recent">`, and two `<GitFileGroup>` elements) with:

```tsx
<CollapsibleSection id="sync" title={`SYNC · ${state.upstream ?? "untracked"}`} actions={<button disabled={busy || !state.upstream} onClick={() => void mutate(() => git.fetch())}>Fetch</button>} collapsed={collapsedSections.sync} onToggle={() => toggleSection("sync")}><div className="git-sync-line"><span>↑{state.ahead} ahead · ↓{state.behind} behind · {formatRelativeTime(state.lastFetchedAt)}</span></div><div className="git-sync-actions"><button disabled={busy || (!state.upstream && !state.branch) || (state.ahead === 0 && !!state.upstream)} onClick={() => void mutate(() => state.upstream ? git.push() : git.push(state.branch))}>Push{state.ahead ? ` ↑${state.ahead}` : ""}</button><button disabled={busy || !state.upstream || state.behind === 0} onClick={() => void mutate(async () => { await git.fetch(); await git.pull(); })}>Pull{state.behind ? ` ↓${state.behind}` : ""}</button></div>{!state.upstream && <p className="git-hint">Untracked branch — Push sets upstream to origin/{state.branch}.</p>}</CollapsibleSection>
{state.lastCommit ? <CollapsibleSection id="current" title="CURRENT" collapsed={collapsedSections.current} onToggle={() => toggleSection("current")}><div className="git-commit-line" title={`${state.lastCommit.hash} · ${state.lastCommit.author} · ${state.lastCommit.date}`}><span className="git-hash">{state.lastCommit.shortHash}</span><span>{state.lastCommit.subject}</span></div><div className="git-meta">{state.lastCommit.author} · {state.lastCommit.date}</div></CollapsibleSection> : <p className="git-empty">No commits yet.</p>}
{state.recent.length > 1 && <CollapsibleSection id="recent" title={`RECENT · ${state.recent.length}`} collapsed={collapsedSections.recent} onToggle={() => toggleSection("recent")}>{state.recent.slice(1).map(commit => <div className="git-commit-line" key={commit.hash} title={`${commit.hash} · ${commit.author} · ${commit.date}`}><span className="git-hash">{commit.shortHash}</span><span>{commit.subject}</span></div>)}</CollapsibleSection>}
<GitFileGroup title="STAGED CHANGES" files={staged} status="index" action="Unstage" disabled={busy} collapsed={collapsedSections.staged} onToggle={() => toggleSection("staged")} onSelect={file => setSelected({ file, staged: true })} onAction={file => void mutate(() => git.unstage(gitFilePaths(file)))} onAll={() => void mutate(() => git.unstageAll())} />
<GitFileGroup title="CHANGES" files={changes} status="workingTree" action="Stage" disabled={busy} collapsed={collapsedSections.changes} onToggle={() => toggleSection("changes")} onSelect={file => setSelected({ file, staged: false })} onAction={file => void mutate(() => git.stage(gitFilePaths(file)))} onAll={() => void mutate(() => git.stageAll())} />
```

Keep lines 87-88 (truncated warning, branch row), 94-98 (clean-tree message, diff viewer, commit box, error) unchanged. Keep the early `if (collapsed === true)` repo-level collapse (line 85) unchanged — it still wins over section state.

- [ ] **Step 3: Run full verification**

Run: `npx tsc -p tsconfig.desktop.json --noEmit`
Expected: PASS

Run: `npx vitest run tests/desktop-gitPanel.test.ts`
Expected: PASS

Run: `npx oxlint src/desktop/renderer/gitPanel.tsx`
Expected: PASS (no warnings)

Run: `node scripts/check-file-size.mjs`
Expected: PASS (`gitPanel.tsx` stays well under 600 lines, ~150 lines)

- [ ] **Step 4: Manual UI check**

Run: `npm run desktop:build`
Expected: renderer bundle builds without errors. Open the desktop app against a repo with 20+ changed files, verify each of the 5 sections toggles independently, counts stay visible when collapsed, Stage/Unstage/Commit/Push/Pull still work, and reopening the panel resets to fully expanded.

- [ ] **Step 5: Commit (include version bump per AGENTS.md)**

```bash
git add src/desktop/renderer/gitPanel.tsx tests/desktop-gitPanel.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(desktop): collapsible git panel sections default expanded"
```

Note: bump patch version (`0.1.132` → `0.1.133` or current) in `src/version.ts`, `package.json`, `package-lock.json` (two fields), `installer/cloudcode.iss` in the same commit — `tests/packaging.test.ts` fails if they disagree.
