# Hand-Rolled Footer via Single Ink Instance

**Date:** 2026-07-12
**Status:** Approved

## Problem

Manually scrolling the terminal viewport should move only the transcript;
the input box and status bar should stay fixed to the terminal's bottom
rows, matching Claude Code. See
`docs/superpowers/specs/2026-07-12-fixed-footer-scroll-margin-design.md`
for the original problem statement and root-cause analysis (why plain
sequential output can never achieve this, and why a DECSTBM scroll margin
is required).

## Why the prior approach (two Ink instances) is abandoned

The prior design (`docs/superpowers/plans/2026-07-12-fixed-footer-scroll-margin.md`)
ran two concurrent Ink `render()` instances against one terminal, using a
DECSTBM margin plus a hand-built cursor-multiplexing primitive
(`src/ui/terminalRegions.ts`, on branch `feature/fixed-footer-scroll-margin`,
abandoned — not merged) to keep both instances' internal repaint state
consistent. Implementation and real-terminal testing found five distinct
bugs in this mechanism, each in a different part of the interop with Ink's
internals:

1. `footerStdout.rows` reporting the small reserved-margin height triggered
   Ink's own internal overflow protection (`outputHeight >= stdout.rows` →
   `clearTerminal`), unconditionally wiping the whole screen on nearly every
   footer repaint.
2. `createWriteMultiplexer`'s cursor-repositioning math needed one row of
   reserved headroom below the footer's visible content, because
   `log-update` (the private module Ink delegates repainting to) always
   believes the cursor rests one row below its last visible content line —
   a "virtual" row that doesn't exist if the footer is placed flush against
   the terminal's true last row.
3. `setFooterRows` (triggered whenever the footer's rendered height
   changes) recreated the footer's Ink instance, whose first write has no
   erase prefix — the *old* footer content at the *old* position was never
   explicitly cleared, appearing as a ghost duplicate.
4. Ink's `App` component writes cursor-visibility escapes
   (`cli-cursor`, on mount/unmount) directly to the stdout it was given,
   completely outside `log-update`'s frame protocol; the multiplexer
   misread these as real frames, corrupting its row tracking.
5. Two Ink instances both having active `useInput` hooks meant two
   `readable` listeners briefly competed for the same shared
   `process.stdin` on every footer remount, because Ink's raw-mode
   reference counting is decremented once synchronously
   (`componentWillUnmount`) but the rest asynchronously (each `useInput`
   hook's own passive-effect cleanup) — silently dropping keystrokes.

Each fix closed one gap and exposed the next — the defining pattern of an
architectural mismatch, not a series of independent bugs. Every one of
these five bugs came from reverse-engineering and patching around
`log-update`'s undocumented internal protocol and Ink's raw-mode
bookkeeping, neither of which Ink exposes as public API or was ever
designed to be shared across two instances. Continuing down this path has
unknown remaining bug count.

## Approach

Go back to a single Ink `render()` instance. `App` (transcript + overlays)
renders through it exactly as before the two-instance work — no more
`Footer` as a separate Ink component tree. The footer (input box, status
bar, suggestion menu) is instead a **hand-rolled, plain-TypeScript module**
with no React and no Ink involvement at all: it owns `process.stdin`
directly, maintains its own state, and writes its own output via absolute
cursor positioning.

This removes three of the five bug classes structurally, not by patching
around them:

- No second Ink instance ⇒ no `log-update` byte-protocol interop, no
  "virtual resting row" headroom requirement, no cursor-hide/show
  interleaving.
- No `useInput` hooks in the footer ⇒ no raw-mode reference-counting race;
  the footer is process.stdin's sole owner, calling `setRawMode` itself,
  once, with no Ink bookkeeping involved.

The remaining two bug classes (stale-content clearing on height changes,
overflow protection) don't apply either, because the hand-rolled writer
chooses its own repaint convention directly instead of reverse-engineering
Ink's — it always knows its own exact row count and erases exactly that
many rows itself; there is no separate "Ink's overflow heuristic" to fool
and no "old instance's stale content" to accidentally leave behind, since
there's no instance teardown/recreation involved when height changes —
just writing fewer or more rows directly.

The one mechanism that *does* carry over from the abandoned work: content's
Ink instance still needs its cursor protected from the footer's writes
(save cursor → move → write → restore cursor), because content is *still*
a normal Ink instance doing its own relative repaint math, trusting nothing
else moves the cursor between its own writes. This is now simpler to
implement than in the abandoned design, since there's no wrapped
`log-update` instance to track row counts for — the footer always knows
its own current row count directly (it produced the lines itself).

### Alternatives considered

- **Continue debugging the two-instance approach**: rejected — the pattern
  of fixes revealing new problems in different places, five rounds deep,
  is the textbook signal to stop and reconsider the architecture rather
  than attempt a sixth fix.
- **Full alt-screen** (own the whole viewport): rejected again, same
  reason as always — destroys native terminal scrollback for the
  transcript, which `<Static>` (`src/ui/MessageList.tsx`) exists
  specifically to preserve.

## Scope

Full feature parity with the current `InputBox`/`StatusBar`/`SuggestionMenu`
components: history recall (up/down arrow), suggestion menu (commands and
file completion via `commands/completion.ts`), backtick line-continuation,
cursor movement (left/right arrow, backspace/delete), Escape to suppress
the menu, Tab/Enter to accept a suggestion or submit. No functional
regression versus what ships today — only the *mechanism* changes.

## Design

### What ports mechanically, unchanged

- `commands/completion.ts` (`getSuggestions`, `applySuggestion`) — pure
  functions, no UI dependency, used as-is.
- `agent/history.ts` — already a plain class with no React/Ink dependency,
  used as-is.
- `src/ui/bottomFill.ts`'s wrap-math helpers (`textRows`, `wrappedRows`) —
  reused for the hand-rolled footer's own line-wrapping.
- `src/ui/StatusBar.tsx`'s formatting functions (`formatTokens`,
  `formatElapsed`) — pure, reused as-is; the JSX component itself is
  replaced by a string-producing equivalent (see below).
- `src/ui/theme.ts` — the `Theme`/`THEMES` color-name definitions are
  reused unchanged; applying them to plain strings uses `ansi-styles`
  (confirmed already present as a transitive dependency — no new package
  needed) instead of Ink's `<Text color>`.

### What gets rewritten as string-building instead of JSX

- The bordered input box (currently `InputBox.tsx`'s JSX) becomes a
  function producing the exact same visual rows as plain strings with
  `ansi-styles` color codes applied.
- The suggestion menu (currently `SuggestionMenu.tsx`) becomes a
  string-producing equivalent, keeping its existing `visibleWindow`/
  `MAX_ROWS` windowing logic (`src/ui/SuggestionMenu.tsx`) — reused as a
  pure function, just no longer returning JSX.
- The status bar line (currently `StatusBar.tsx`'s JSX) becomes a
  string-producing equivalent using the same segment-joining logic.

### New module: the footer controller

A new plain-TypeScript module (file structure decided at planning time)
owns:

1. **Input state** — value, cursor position, selected suggestion index,
   suppressed-menu flag, at-token tracking for file completion — ported
   from `InputBox.tsx`'s existing `useRef`-backed state, which is already
   largely imperative (the `useState` calls there mostly mirror ref state
   purely for JSX re-render triggering, which no longer applies).
2. **Raw stdin reading** — calls `process.stdin.setRawMode(true)` once
   itself (sole owner, no Ink involved), parses incoming keypress data
   (arrow keys, backspace, tab, enter, escape, ctrl+c, printable
   characters) equivalently to what Ink's `useInput`/`parse-keypress`
   currently does for `InputBox`'s `useInput` handler body — the exact
   key-handling logic in `InputBox.tsx`'s `useInput` callback (lines
   172–243 as it exists on `master`) ports essentially unchanged, since it
   already receives a parsed `(input, key)` shape; only the source of that
   parsed shape changes from Ink's hook to our own stdin parser.
3. **Rendering + writing** — computes the footer's current lines (input
   box + optional suggestion menu + status bar), and writes them via
   absolute cursor positioning wrapped in save/restore, following the
   corrected mechanism from the abandoned design's Task 1 spec section
   ("Why naive save/move/restore is wrong, and the corrected mechanism" in
   `docs/superpowers/specs/2026-07-12-fixed-footer-scroll-margin-design.md`)
   — simplified: since there's no wrapped `log-update` instance, the
   writer tracks its own row count directly from the lines it produces,
   with no `eraseLines`-prefix-parsing needed.
4. **DECSTBM margin lifecycle** — same idea as the abandoned design's
   `createRegions`: set the scroll margin so content's Ink instance is
   confined to rows above the footer, re-issue it when the footer's row
   count changes or the terminal resizes, reset it (`\x1b[r`) on process
   exit and `SIGINT`. Simpler than before: only one writer (the footer
   controller itself) needs the margin-aware origin math; content's Ink
   instance just needs a `.rows`-shrinking `stdout` proxy, no multiplexer.

### Content instance

`App`'s single Ink `render()` call receives a `stdout` proxy whose `.rows`
is shrunk by the footer's current row count (recomputed whenever that
count changes), matching the "content gets a smaller reported terminal"
half of the abandoned design's `createRegions` — reused conceptually, not
byte-for-byte, since the footer-side complexity that drove most of
`terminalRegions.ts`'s size no longer applies.

### Keyboard/exit handling

`Escape` (interrupt), `Shift+Tab` (cycle permission mode), `Ctrl+C`
(double-press to exit) — currently `Footer.tsx`'s own `useInput` handler —
move into the same raw-stdin parsing the footer controller already owns,
calling the same `onEscape`/`onShiftTab`/`onCtrlC` callbacks `App` already
exposes.

### Data flow: footer needs from `App`

`App` still owns and computes everything the footer displays (provider,
model, cost, tokens, git status, elapsed time, permission mode, streaming
state) and everything it submits to (`onSubmit`, slash-command dispatch).
Since the footer is no longer a React tree, this is a plain callback/event
subscription registered directly in `cli.tsx` (not a React context/bus) —
`App` calls a plain function whenever its footer-relevant state changes;
the footer controller receives it and re-renders its own next frame from
the latest snapshot.

### Testing

- The footer controller's pure logic (suggestion/history/cursor state
  transitions, line-wrapping, string rendering) is unit-testable directly
  — no `ink-testing-library` needed for this module, since it isn't an
  Ink/React component. Plan to decide exact test file structure, but the
  bar is the same: real behavior verified, not mocked.
- The DECSTBM margin + cursor-save/restore writer is unit-testable the
  same way the abandoned design's `terminalRegions.ts` primitives were —
  byte-level assertions on the exact escape sequences produced.
- Manual real-terminal verification remains required for the actual
  scroll-pinning behavior (unchanged from before — no test harness can
  simulate real terminal scrollback).
