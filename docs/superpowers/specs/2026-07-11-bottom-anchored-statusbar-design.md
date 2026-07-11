# Bottom-Anchored Status Bar (Claude Code-style footer pinning)

**Date:** 2026-07-11
**Status:** Approved

## Problem

cloudcode's footer (InputBox + StatusBar) sits directly under whatever content
exists, so with a short transcript it renders near the top of the terminal and
drifts downward as messages accumulate. Claude Code instead pins the input box
and status bar to the terminal's last rows from the moment the app starts,
padding unused vertical space with blank rows.

There is no bottom-anchoring logic anywhere in the codebase today: `App.tsx`
renders a single top-down `<Box flexDirection="column">` of
`MessageList → live region → InputBox → StatusBar`, and the only place
`stdout.rows` is consulted is the stream-tail cap at `App.tsx:391`.

## Goal

The InputBox + StatusBar sit flush against the terminal's bottom edge whenever
total content is shorter than the terminal, matching Claude Code's behavior.
Once output exceeds one screen, behavior is unchanged (the terminal has
scrolled and the dynamic region naturally sits at the bottom).

## Approach: measured filler

Insert a blank filler `<Box>` above the footer, sized to the unused vertical
space. Chosen over two alternatives:

- **Estimated filler** (reuse the fixed `-14`-style row budget, no measuring):
  simpler but drifts 1–3 rows when lines wrap or markdown renders taller than
  estimated.
- **Fullscreen alt-screen mode** (own the viewport like vim/htop): trivial
  pinning but destroys native terminal scrollback, requiring the `<Static>`
  transcript design in `MessageList.tsx` to be replaced with an in-app scroll
  view. Too large a change; not how Claude Code works.

## Design

### The scrollback subtlety

The transcript renders through `<Static>` (`MessageList.tsx`), which writes
items into terminal scrollback and out of Ink's layout tree — so Ink's
`measureElement` cannot see how many rows the transcript occupies. This only
matters early in a session: once total output exceeds one screen, filler is 0
and nothing changes. The two parts of the screen are therefore handled
differently.

### Components

1. **Static row counter (counted, not measured).** Maintain a running count of
   terminal rows emitted by transcript items as they are appended, using the
   same wrap math as `streamTail.ts`: `max(1, ceil(lineLength / columns))` per
   line, against `stdout.columns`. Reset the counter when `resetItems()` runs
   (`/clear`, resume picker). The welcome banner counts into this like any
   other item.

2. **Dynamic region measurement (measured).** Wrap the live region (stream
   tail, WorkingIndicator/ProgressBar, pickers, permission dialog, InputBox,
   StatusBar) in a `<Box ref>` and read its rendered height with Ink's
   `measureElement` after render (in a layout effect).

3. **Filler.** A `<Box height={filler} />` placed just above the
   InputBox/StatusBar block:

   ```
   filler = max(0, stdout.rows - staticRows - dynamicRows - 1)
   ```

   The `-1` keeps total rendered height strictly under terminal height,
   avoiding Ink's clear-whole-screen repaint mode that breaks mouse scrolling
   (the failure mode already documented in the comment at `App.tsx:380`).

4. **Resize handling.** Recompute filler on `stdout` resize events (rows and
   columns both affect the math; column changes also change wrap counts, so
   the static row counter recomputes from the items array on resize rather
   than being purely incremental).

### Data flow

```
items[] ──(wrap math vs columns)──▶ staticRows ─┐
live region ──(measureElement)──▶ dynamicRows ──┼──▶ filler height ──▶ <Box height={filler}/>
stdout.rows/columns ────────────────────────────┘
```

### Error handling

- `stdout` undefined (non-TTY/tests): fall back to `rows ?? 24`,
  `columns ?? 80`, same as the existing stream-tail cap.
- `measureElement` returning 0 before first layout: treat as 0; the filler
  corrects on the next render.
- Filler is clamped to ≥ 0 in all cases; overflow simply means filler = 0
  (current behavior).

## Known trade-off

While the filler is active (short transcript), the dynamic region spans most
of the screen, so each re-render repaints more rows. The StatusBar's
elapsed-time segment ticks every second (`App.tsx:233-236`), producing a
near-full-screen repaint per second at session start. This mirrors what Claude
Code effectively does. If it visibly flickers in VS Code's integrated
terminal, a follow-up can stop ticking the timer while idle; that is out of
scope here.

## Testing

- Unit tests for the filler-height function — pure function of
  `(rows, columns, staticRows, dynamicRows) → filler` — covering: short
  content (positive filler), exact fit (0), overflow (clamped to 0), and the
  `-1` reserve.
- Unit tests for the static row counter against single-line, multi-line, and
  wrapped items (line longer than `columns`), plus reset behavior.
- Component test in `tests/app.test.tsx` style (ink-testing-library) asserting
  the footer renders after blank filler rows for a short transcript.
