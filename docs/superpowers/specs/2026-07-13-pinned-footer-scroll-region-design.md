# Pinned-Bottom Footer via Terminal Scroll Region — Design

## Context

The native TUI was just migrated (see `docs/superpowers/plans/2026-07-13-inline-scrollback-tui.md`) from a full-screen alt-screen repaint to an inline renderer: transcript rows are committed once into the terminal's normal scrollback and never rewritten, while a "dynamic block" (streaming preview, work indicator, input box or overlay, status bar) is repainted each frame directly below the last committed row using cursor-relative movement.

That fixed text selection, but the footer now floats — it sits right after the last message and only reaches the terminal's bottom edge once there's enough content to fill the screen. The user wants the footer pinned to the bottom edge from the start, like `tmux`/`htop`/`less`'s status line.

## Goal

Pin the footer (status bar + input box, or overlay) to the terminal's bottom rows at all times, while the message area above it keeps using the terminal's native scrollback for wheel-scroll and mouse selection — without regressing anything Task 1–5 of the prior plan established.

## Approach

Use a terminal **scroll region** (DECSTBM, `ESC[top;bottom r`) to split the screen into two independent parts:

- **Scroll region** — rows `1` through `rows - footerHeight`. Holds the committed transcript. Content written here that exceeds the region's height causes the terminal to scroll *only that region*; the line that scrolls off the top is pushed into the terminal's native scrollback buffer, exactly as full-screen scrolling does today.
- **Footer band** — the remaining `footerHeight` rows at the bottom, outside the scroll region. Repainted every frame via absolute cursor addressing confined to just those rows.

This is the standard technique split-pane terminal apps use and is the only way to keep a footer physically anchored to the bottom edge without a full-screen repaint.

## Components

### `src/ui/term/ansi.ts`

Add two helpers:

```ts
export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export const RESET_SCROLL_REGION = "\x1b[r";
```

`cursorTo(row, col)` already exists (currently unused since the Task 3 rewrite dropped it) — it becomes the footer-positioning primitive again, but now scoped to only the footer's row range instead of the whole screen.

### `src/ui/term/render.ts` — `InlineRenderer`

Replaces the single `lastDynamicLines` counter with region-aware state:

- `lastFooterHeight: number` — the dynamic block's line count as of the last frame.
- `lastRows: number`, `lastColumns: number` — the terminal size as of the last frame.

`frame()` sequence, each call:

1. Build the dynamic block exactly as today (same bottom-up assembly: status bar, overlay-or-input, compact progress, work indicator, streaming tail), capped so `footerHeight <= rows - 1` (at least 1 row must remain for the scroll region).
2. If `footerHeight !== lastFooterHeight` or the terminal size changed, emit `setScrollRegion(1, rows - footerHeight)` to redefine the boundary, then update `lastFooterHeight`/`lastRows`/`lastColumns`. This does not erase content in either region.
3. Position the cursor at the bottom row of the scroll region (`cursorTo(rows - footerHeight, 1)`), then write every newly-committed row (`buffer.takeCommitRows(columns, theme)`) each followed by `\r\n`. Because the cursor is confined to the scroll region, writes that would advance past its bottom instead scroll the region — new committed rows appear at the bottom of the message area and old ones scroll up into native terminal scrollback, matching current behavior.
4. Jump to the footer's first row (`cursorTo(rows - footerHeight + 1, 1)`), erase that band (`ERASE_DOWN` is safe here — footer is always the last thing on screen, so "erase to end of screen" only touches footer rows), and paint the footer's lines top-to-bottom.

`invalidate()` resets `lastFooterHeight` to `0` and `lastRows`/`lastColumns` to `-1` so the next `frame()` unconditionally redefines the region (used after a full `CLEAR_AND_HOME`, same trigger points as today: Ctrl+L, `/new`, resume-picker pick).

`finalize()` returns `RESET_SCROLL_REGION + "\r\n"` — restoring the full-screen scroll region before the process hands control back to the shell is required, otherwise the shell prompt would be visually confined to the old message sub-region.

### `src/ui/nativeApp.ts`

No shape changes to `recompute()` — it still just calls `renderer.frame(buffer, bottom, theme, size)`. The three existing `CLEAR_AND_HOME` + `renderer.invalidate()` call sites (Ctrl+L, `clearSession`, `pickResume`) are unchanged in behavior: a full clear still works correctly because `invalidate()` now also forces the next frame to redefine the scroll region from scratch, matching the fresh blank screen.

### `src/ui/term/terminal.ts`

`cleanup()` gains `RESET_SCROLL_REGION` ahead of the sequence it already writes, as a safety net: if the process exits or crashes without going through `App.stop()` (e.g. an uncaught exception), the terminal must not be left with a restricted scroll region.

## Data flow / state

Region redefinition is conditional on `footerHeight` or terminal size actually changing — not emitted every frame. In the steady state (typing with a stable-height footer, or streaming where the preview height hasn't changed since the last frame), a frame costs exactly what it costs today: one footer repaint plus any newly-committed transcript rows. Only footer-height transitions (streaming starts/stops, overlay opens/closes, compact progress appears) or a real terminal resize add the one extra `setScrollRegion` write.

## Error handling

If `footerHeight >= rows` (a pathologically small terminal), clamp so the scroll region always keeps at least 1 row: `scrollBottom = Math.max(1, rows - footerHeight)`, and cap `footerHeight` accordingly so the two regions never overlap or invert — same defensive spirit as the existing `rows - 1` visible-dynamic-block cap from the prior plan.

## Testing

`tests/render.test.ts` (or a focused new file) gets:

- Region-definition escape (`\x1b[1;NBr` pattern) appears in the output only on the first frame and again only after a footer-height or size change — not on back-to-back frames with an unchanged footer.
- The message-region write path never uses absolute cursor addressing that targets a row *inside* the scroll region (i.e. still relative/append-only there) — this replaces the old blanket "no absolute positioning anywhere" assertion, which is no longer true for the footer band by design.
- Footer painting *does* use absolute addressing, confined to `rows - footerHeight + 1 .. rows`.
- `finalize()` output contains `RESET_SCROLL_REGION`.
- `invalidate()` forces the next `frame()` to redefine the region even if the footer height happens to be unchanged.

## Known limitation (carried forward)

Shrinking the terminal still reflows already-committed rows imperfectly — the same accepted tradeoff documented in the prior plan, now scoped to the message sub-region rather than the whole screen. Not something this design attempts to fix.
