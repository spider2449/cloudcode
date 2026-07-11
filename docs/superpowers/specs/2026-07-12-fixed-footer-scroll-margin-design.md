# Fixed Footer via Terminal Scroll Margin

**Date:** 2026-07-12
**Status:** Approved

## Problem

cloudcode's InputBox + StatusBar currently sit at the bottom of the terminal
only as a side effect of being the last thing rendered each frame (the
bottom-anchored-statusbar feature, see
`docs/superpowers/specs/2026-07-11-bottom-anchored-statusbar-design.md`,
merged to master). That fixes the "footer at wrong height" problem but not
this one: when the user manually scrolls the terminal's viewport (mouse
wheel, scrollbar) to review history, the footer scrolls away with everything
else, because every frame cloudcode writes — including footer repaints — is
ordinary sequential terminal output living in the same scrollback buffer.
Scrolling the viewport up moves to an earlier window of that buffer, where
the footer hadn't been drawn yet, so it disappears.

Claude Code's footer does not do this: while scrolling, only the transcript
moves; the input box and status bar stay fixed to the terminal's last rows.

## Root cause

There is no way to exempt specific rows from a terminal's scrollback using
plain sequential output — once written, everything is part of the same
linear history. A row can only be excluded from scrollback if the terminal
itself treats it as outside the scrolling region, via a DECSTBM
(`\x1b[top;bottomr`) scroll margin: content inside the margin scrolls (and
feeds scrollback) normally; a fixed footer is drawn in the excluded rows
with absolute cursor positioning and never enters history.

The alternative — full alt-screen ownership — was already rejected during
the bottom-anchored-statusbar design: it would remove native terminal
scrollback entirely, which cloudcode's `<Static>`-based transcript
(`src/ui/MessageList.tsx`) exists specifically to preserve.

## Goal

Manually scrolling the terminal viewport moves only the transcript. The
input box and status bar remain fixed to the terminal's bottom rows,
matching Claude Code, using a real terminal scroll margin rather than the
filler-padding approach (which cannot achieve this — filler rows are still
part of the same scrollback stream).

## Scope decision

Only `InputBox` + `StatusBar` become truly fixed. Everything else that
currently renders below the transcript — `WorkingIndicator`, the streaming
text tail, the compaction `ProgressBar`, `PermissionDialog`,
`ResumePicker`/`ProjectPicker`, and `InputBox`'s own `SuggestionMenu` overlay
— continues to render above the margin as ordinary scrolling content, exactly
as it does today. This keeps the scroll-margin resize logic bounded to input
wrapping and terminal resize, rather than needing to resize on every
transient overlay's appearance.

## Approach

Two concurrent Ink `render()` instances share one real terminal, coordinated
by a DECSTBM scroll margin.

- **Content instance** renders the existing `App` tree (transcript +
  overlays). Its `stdout` is a proxy reporting `rows = realRows -
  footerRows`; writes pass through untouched. Because Ink's own
  overflow-protection math (the clear-whole-screen repaint path) reads
  `stdout.rows`, this proxy is what keeps the content instance from ever
  writing into the margin.
- **Footer instance** renders a new `Footer` tree (`InputBox` + `StatusBar`,
  lifted out of `App.tsx` unchanged). Its `stdout` is a proxy that wraps
  every `.write()` with save-cursor → move to the footer's absolute origin
  row → passthrough → restore-cursor, so Ink's normal relative-repaint
  diffing keeps working but always lands in the fixed margin rows.
- A coordinator (`src/ui/terminalRegions.ts` + wiring in `cli.tsx`) owns the
  DECSTBM lifecycle: it computes `footerRows` from the existing
  `inputBoxRows()` helper (`src/ui/bottomFill.ts`, reused from the prior
  feature) whenever the InputBox's rendered height or the terminal size
  changes, and re-issues the margin + forces a full footer repaint at the
  new origin when `footerRows` changes.

This was chosen over two alternatives:

- **Hand-rolled ANSI footer, single Ink instance**: avoids running two Ink
  instances, but requires duplicating `InputBox`/`SuggestionMenu`'s cursor
  and wrapping logic outside Ink's reconciler instead of reusing the
  component already trusted in production. Rejected — more code, more
  surface for cursor-position bugs.
- **Full alt-screen**: trivial pinning, but destroys native scrollback for
  the transcript, which contradicts the entire goal (only the transcript
  should scroll — inside the terminal's real history, not an app-managed
  viewport). Already rejected in the prior feature's design for the same
  reason.

## Design

### `src/ui/terminalRegions.ts` (new)

```
createRegions(stdout: NodeJS.WriteStream, initialFooterRows: number): {
  contentStdout: <stdout-like proxy>;
  footerStdout: <stdout-like proxy>;
  setFooterRows(rows: number): void;
  teardown(): void;
}
```

- `contentStdout`: same object as `stdout` for `.write()`, but with `.rows`
  overridden to `stdout.rows - currentFooterRows` (read live, not cached, so
  a resize is always reflected on the next read). `.columns` passes through
  unchanged. Resize events re-emit through this proxy so `useStdout`'s
  resize listener in `App.tsx` keeps working. `.write()` passes straight
  through to the real `stdout` unmodified — the content instance is never
  itself repositioned, only ever interrupted transiently by footer writes
  (see below), which restore it exactly.

#### Why naive save/move/restore is wrong, and the corrected mechanism

Ink does not do absolute cursor positioning internally. It delegates all
repainting to `log-update` (`node_modules/ink/build/log-update.js`), which
tracks only "how many lines did I write last frame" (`previousLineCount`)
and repaints with a purely *relative* sequence:
`ansiEscapes.eraseLines(previousLineCount) + output`, where `eraseLines`
erases and cursor-ups `previousLineCount` times from **wherever the cursor
currently is**, and `output` (`str + '\n'`) leaves the cursor one row below
its own last content line once written. `log-update` has no concept of
absolute rows and Ink exposes no hook to override it.

An earlier version of this design proposed wrapping every footer write with
save-cursor → move to the fixed footer origin (top row of the margin) →
passthrough → restore-cursor. This is incorrect: `eraseLines` assumes the
cursor sits at the **bottom** of the previous footer frame
(`footerOrigin + footerLastHeight`), not the top. Repositioning to the top
before forwarding a write makes `eraseLines(footerLastHeight)` erase upward
from the wrong row — into the content region above the margin — once the
footer has rendered more than one frame. The content instance's own
invariant is unaffected by this bug (footer's save/restore correctly
protects content's cursor across interleaved footer writes), but the
footer's own frame-to-frame consistency breaks.

**Corrected mechanism.** `footerStdout.write(data)` is wrapped as:

1. Save cursor (`\x1b7`).
2. Move to `(footerOrigin + footerLastHeight, 1)` — the row where
   `log-update` actually expects to resume, not the margin's top row.
3. Forward `data` unmodified.
4. Determine `newHeight`: strip the leading `eraseLines(footerLastHeight)`
   prefix from `data` (a fixed, parseable byte pattern — repeated
   `\x1b[2K\x1b[1A` pairs, ending in `\x1b[2K\x1b[G` when
   `footerLastHeight > 0`, or empty when `footerLastHeight === 0`) and count
   the newlines in the remainder (`output = str + '\n'`).
   `footerLastHeight = newHeight` for the next call. This is fully
   deterministic and synchronous — it does not depend on `measureElement`
   or React effect timing, both of which can lag or coincide with a second
   write for the same instance before an effect fires.
5. Restore cursor (`\x1b8`).

`footerOrigin` and `footerLastHeight` are tracked internally by
`createRegions`, not exposed. `footerLastHeight` resets to 0 whenever
`setFooterRows` changes the margin (see below), since the footer's next
write after a margin change is always a full repaint at the new origin.

Because this depends on `log-update`'s and `ansi-escapes`' exact internal
output format (two dependencies deep inside Ink, not part of Ink's public
API), the plan's first task is a standalone spike validating this mechanism
against real `ansi-escapes` output and in a real terminal, before any
`App`/`Footer` wiring is built on top of it.

- `setFooterRows(rows)`: if `rows !== currentFooterRows`, updates
  `currentFooterRows`, writes the margin sequence
  `\x1b[1;${realRows - rows}r` directly to the real `stdout`, resets
  `footerLastHeight` to 0 (the footer's next write is a full repaint at the
  new origin), and marks the footer instance for a full repaint (see Footer
  instance notes below — exact mechanism, e.g. remounting vs. an
  Ink-exposed clear, is an implementation-time decision documented in the
  plan).
- `teardown()`: resets the margin to full-screen (`\x1b[r`) — see Process
  exit below.

### `src/ui/Footer.tsx` (new)

Lifted verbatim from the JSX currently at the bottom of `App.tsx`
(`InputBox` + `StatusBar`), plus the `useInput` hook that currently lives in
`App.tsx` (moves here, since only one Ink instance should own raw-mode
stdin — the instance hosting the interactive input). Props are whatever
`App.tsx` currently closes over for these two components and the input
hook: submit handler, permission-mode cycling, interrupt/exit handling, and
the state needed to render `StatusBar` (provider, model, cost, tokens, git
status, etc.) — passed down from `cli.tsx`'s `Root` alongside `App`, not
threaded through `App` itself.

### `src/ui/App.tsx`

Loses the `InputBox`/`StatusBar`/filler JSX, the `useInput` hook, and the
`bottomFill.ts` filler-height plumbing added in the prior feature (no longer
needed — the DECSTBM margin is what keeps the footer at the bottom now, not
padding). Keeps the transcript and all overlays (`WorkingIndicator`,
`ProgressBar`, pickers, `PermissionDialog`) exactly as today. Its
`stdout?.rows`/`columns` reads (e.g. the stream-tail cap) now read the
content proxy's already-correct (shrunk) values with no changes needed at
those call sites.

### `src/cli.tsx`

Creates the regions via `createRegions`, renders the content tree with
`render(<App ... />, { stdout: contentStdout })` and the footer tree with a
second `render(<Footer ... />, { stdout: footerStdout })`. Owns the
coordinator effect/logic that watches InputBox's rendered height (via the
existing `inputBoxRows()` helper, fed by whatever state `Footer` needs to
expose upward — e.g. the same same-batch callback pattern
(`onInputRowsChange`) already built for the bottom-anchored-statusbar
feature, reused rather than reinvented) and the terminal's resize events,
calling `setFooterRows` when either changes. Registers `process.on('exit')`
and `process.on('SIGINT')` handlers that call `teardown()` so the scroll
margin is always reset before the process ends, even on abnormal exit —
otherwise the user's terminal stays permanently margin-restricted after
cloudcode quits.

### `src/ui/bottomFill.ts`

`staticRows`, `fillerHeight`, `liveRegionFloor`, and their supporting
constructs (added for the prior feature) are removed — the filler-padding
approach they implement is superseded by the real scroll margin and is no
longer used anywhere. `inputBoxRows()` (and the row-counting helpers it
depends on, e.g. `textRows`) are kept and reused for footer-height sizing.

## Data flow

```
InputBox value/cursor change (footer instance)
  -> inputBoxRows() recomputed
  -> if changed: cli.tsx coordinator calls setFooterRows(newHeight)
  -> terminalRegions writes \x1b[1;{realRows-newHeight}r
  -> footer instance forced to full-repaint at new origin

Terminal resize (real stdout 'resize' event)
  -> both proxies' rows/columns reflect new size on next read
  -> cli.tsx coordinator recomputes footerRows, re-applies margin if needed

Transcript/overlay output (content instance)
  -> written via contentStdout, lands only in rows 1..(realRows-footerRows)
  -> that region is what real terminal scrollback captures
  -> footer rows never enter scrollback -> manual scroll only moves transcript
```

## Error handling

- **DECSTBM unsupported by the terminal:** not reliably detectable by
  probing without adding complexity explicitly out of scope per this
  project's compatibility decision (assume modern terminal support, no
  fallback path — matches the prior feature's target environments: VS Code
  integrated terminal, Windows Terminal, xterm-compatible). Worst case on an
  unsupported terminal is a cosmetic no-op margin (footer behaves like
  before this feature), not a crash.
- **Process exit (normal or abnormal):** `teardown()` must run via
  `process.on('exit')` and `process.on('SIGINT')` so the scroll margin is
  always reset (`\x1b[r`) before the terminal is handed back to the user;
  otherwise the user's shell remains margin-restricted after cloudcode
  quits.
- **Margin resize race:** `setFooterRows` reads `realRows` live at call
  time, not from a stale closure, so a resize landing between two footer
  height changes cannot compute an escape sequence against outdated
  terminal dimensions.

## Testing

- **Spike gate, before any other work.** Because the cursor-multiplexing
  mechanism above depends on `log-update`'s and `ansi-escapes`' exact
  internal output format — two dependencies deep inside Ink, undocumented
  as public API — the implementation plan's first task is a standalone
  spike: build `terminalRegions.ts`'s write-wrapping and erase-prefix
  parsing in isolation (no `App`/`Footer` wiring), unit test it against
  real `ansi-escapes.eraseLines()` output, and manually verify it in a real
  terminal (VS Code integrated terminal at minimum): two interleaved fake
  Ink-like writers, confirm no visual corruption after many interleaved
  frames and after a `setFooterRows` change. This is a go/no-go checkpoint
  before the rest of the plan proceeds.
- `terminalRegions.ts` is pure enough to unit test directly: feed it a mock
  `stdout` (extending the existing ink-testing-library-style fake used
  elsewhere in this codebase) and assert the exact escape sequences written
  for: initial margin set, a `setFooterRows` height change, a resize event,
  and `teardown()`.
- `Footer.tsx` is tested standalone with `ink-testing-library`, the same way
  `InputBox`/`StatusBar` are already tested — no behavior change to those
  components themselves, so existing tests for them should need minimal
  changes beyond relocation.
- A full `App` + `Footer` two-instance interaction test (verifying real
  scrollback behavior) is not practical under `ink-testing-library`, which
  has no real terminal/scrollback concept. That layer is verified by manual
  smoke test in a real terminal (VS Code integrated terminal at minimum),
  the same verification gap accepted for prior features requiring real-TTY
  confirmation (bottom-anchored-statusbar, compact/init/theme, packaging).
