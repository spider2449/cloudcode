# Desktop Git Panel Collapse Design

Date: 2026-09-14
Status: Approved
Scope: `src/desktop/renderer/gitPanel.tsx` only (plus tests in `tests/desktop-gitPanel.test.ts`)

## Problem

The right-side Git panel lists every section (SYNC / CURRENT / RECENT /
STAGED CHANGES / CHANGES) fully expanded. When CHANGES grows to dozens of
files, the panel becomes hard to scan and the Commit box is pushed out of
view. Only the whole-repo card is collapsible today.

## Decision

Option A: generic collapsible sections. All five blocks get a `▸/▾`
toggle. Default is always fully expanded with no persistence. Rejected:
auto-collapse heuristics (adds magic thresholds) and folder-grouped trees
(too much UI for this request). Inner-scroll for long file lists is a
possible follow-up, not part of this change.

## Design

### 1. New `CollapsibleSection` internal component

```tsx
function CollapsibleSection({ id, title, actions, collapsed, onToggle, children }) {
  return (
    <section>
      <div className="section-heading">
        <button className="bare-button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`} aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed ? "▸" : "▾"}
        </button>
        <span>{title}</span>
        {actions}
      </div>
      {!collapsed && children}
    </section>
  );
}
```

- Reuses existing `section-heading` and `bare-button` styles, matching the
  `repo-header` `▸/▾` pattern. No new CSS required.
- SYNC / CURRENT / RECENT render through this wrapper.
- Titles keep their counts when collapsed (e.g. `CHANGES · 12`,
  `RECENT · 5`, `SYNC · origin/main`) so collapsed state stays informative.

### 2. `GitFileGroup` extension

- Add optional `collapsed?: boolean` and `onToggle?(): void` props.
- Header becomes: toggle button + `TITLE · N` + existing action button
  (`Stage all` / `Unstage all`).
- Collapsed: render header only. Expanded: render current file rows.
- Empty groups keep `return null` (no empty header shown).

### 3. State ownership

- `GitRepoCard` holds `useState<Record<"sync" | "current" | "recent" | "staged" | "changes", boolean>>`, all `false` (expanded) initially.
- No `localStorage`, no props lifting to `src.tsx`. Remount resets to fully
  expanded per requirement "always fully expanded".
- Data flow unchanged: `git.branches()` / `git.diff()` effects, `mutate()`
  helper, and commit/sync actions are untouched. Collapsed sections simply
  skip rendering children (diff fetch effect still driven by `selected`,
  which cannot be set from a collapsed list).

### 4. Accessibility

- Toggle buttons carry `aria-label="Expand|Collapse <TITLE>"` and
  `aria-expanded`.
- Keyboard: native `<button>` focus/Enter/Space, no custom key handling.

### 5. Edge cases

- `!state` / `!isGitRepo`: unchanged loading / not-a-repo messages.
- `state.truncated` warning stays above sections, unaffected by collapse.
- `CURRENT` with no commits stays plain `No commits yet.` text, not wrapped.
- Whole-repo `collapsed` (existing prop) still short-circuits everything.

## Testing

- Extend `tests/desktop-gitPanel.test.ts` in place (1:1 mapping preserved):
  document collapse contract at the helper level where possible; full
  toggle interaction is manual via `npm run desktop` against a repo with
  many changes.
- Verify: each section toggles independently, counts stay visible when
  collapsed, Stage/Unstage/Commit/Push/Pull still work, repo-level collapse
  still wins, clean tree shows no empty headers.
- Run `npm run typecheck:desktop` and the vitest file.

## Follow-ups (out of scope)

- Inner `max-height + overflow-y: auto` for expanded CHANGES lists.
- Folder-grouped collapsible tree for monorepos.
- Persisted collapse state if users later ask for it.
