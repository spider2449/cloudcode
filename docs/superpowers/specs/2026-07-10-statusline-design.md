# Status Line Enhancement — Design

Date: 2026-07-10
Status: Approved (Approach A)

## Goal

Extend cloudcode's built-in status bar (bottom line of the TUI) to show richer
session information, similar to Claude Code's status line:

`model · mode · ⎇ branch* · 12.3k tok (6%) · $0.0123 · 4m 12s · cwd`

Segments: model + permission mode (existing), git branch with dirty flag,
cumulative token usage with context-window percentage, session cost (existing),
session elapsed time, and cwd (existing). Empty/unavailable segments are omitted.

## Architecture

Approach A: App owns all state; `StatusBar` stays a pure presentational
component. One new hook encapsulates git polling.

### Components

1. **`src/ui/useGitStatus.ts`** (new)
   - React hook returning `{ branch?: string; dirty: boolean }`.
   - Runs `git rev-parse --abbrev-ref HEAD` and `git status --porcelain -uno`
     asynchronously via `child_process.execFile` in the session cwd.
   - Refreshes on a ~5s interval and immediately after each completed turn
     (caller passes a `refreshKey` that changes per turn).
   - Outside a git repo or on any git error: returns `{ dirty: false }` with
     no branch; the segment is simply hidden. Never throws, never blocks UI.

2. **`src/ui/App.tsx`** (modified)
   - In the existing result-message handler (where `total_cost_usd` is
     accumulated), also read `usage` and accumulate:
     `inputTokens += input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
     `outputTokens += output_tokens`. Missing fields treated as 0.
   - Record `startedAt` once on mount; a 1-second interval drives the elapsed
     display.
   - Compute `contextPct` from the latest turn's input tokens against the
     model's context window (default 200_000; unknown model → percentage
     omitted).
   - Pass `tokens`, `contextPct`, `elapsedMs`, and git info to `StatusBar`.

3. **`src/ui/StatusBar.tsx`** (modified)
   - New props: `gitBranch?`, `gitDirty?`, `tokens?`, `contextPct?`,
     `elapsedMs?` (all optional; component renders whatever is provided).
   - Renders segments joined by ` · `, dim gray as today.
   - Formatting: tokens as `12.3k tok`; dirty flag as `*` suffix on branch;
     elapsed as `4m 12s` (hours shown when ≥ 1h); cost as `$0.0123` only
     when > 0.

## Error Handling

- Git failures: swallowed; segment hidden.
- Unknown model: token count still shown, context % omitted.
- No usage data from provider: token segment hidden.

## Testing

- Unit tests for `StatusBar` rendering permutations (ink-testing-library):
  all segments, minimal segments, dirty flag, hour-scale elapsed.
- `useGitStatus` tested by injecting a fake exec function (hook accepts an
  optional exec parameter for tests).
- No changes to existing tests' expectations beyond StatusBar props.

## Out of Scope

- User-configurable status line command (Claude Code's `statusLine` setting).
- Per-model context-window table beyond a simple default constant.
