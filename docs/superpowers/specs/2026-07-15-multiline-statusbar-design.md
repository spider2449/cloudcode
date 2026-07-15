# Multi-line Status Bar Design

Date: 2026-07-15

## Problem

The native TUI status bar truncates with an ellipsis when the terminal is
narrower than the joined segment text, hiding segments (cwd, cost, elapsed)
on narrow windows.

## Decision

Wrap the status bar at segment boundaries onto multiple rows instead of
truncating. Chosen over hard-wrapping mid-segment (unreadable) and over
dropping low-priority segments (hides information).

## Design

- `renderStatusBar(props, theme, width)` returns `string[]` (one entry per
  screen row) instead of `string`.
- Packing: greedily fill each row with whole segments joined by `" · "`;
  when the next segment plus separator would exceed `width`, start a new row.
- A single segment longer than the full width is ellipsis-truncated on its
  own row. Invariant: no emitted row is ever wider than the terminal
  (legacy conhost ignores DECAWM-off; over-width rows corrupt the display).
- Every row is wrapped in the theme's muted color, as today.
- Caller change: `InlineRenderer.frame` pushes the returned rows with spread
  (`dyn.push(...renderStatusBar(...))`). Footer height and scroll region
  already adapt per frame, so no other changes are needed; a width resize
  re-packs automatically via `recompute()`.

## Testing

- Segments that fit stay on one row.
- Overflow wraps at a segment boundary; no row exceeds `width`.
- An over-width single segment is truncated with `…`.
- Renderer places all status rows at the footer bottom.
