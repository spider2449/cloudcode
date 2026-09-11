# GUI Busy Indicator + Live /theme Design (2026-09-11)

Two small UX gaps, one spec. User-approved on 2026-09-11.

## A. GUI busy `....` animation

Problem: the desktop GUI only shows a small Stop button while the LLM is
working (`desktop/renderer/chatPane.tsx:318`). No text status, easy to miss.

Design:
- When `pendingIds.length > 0`, show an animated `Thinking....` label next
  to the Stop button. The dots cycle 0-4 via a CSS `@keyframes` animation
  (muted color, pure CSS, no timers).
- Disable Send while busy to prevent duplicate submits.
- Hide on `done`/`error` chat events (existing `pendingIds` removal at
  `chatPane.tsx:146` already drives this).
- No change to the chat event protocol; driven purely by the renderer's
  existing `pendingIds` state.
- TUI unchanged: `inputBox.ts:147` already shows `working… (Esc to interrupt)`.

Tests: renderer-side coverage for show/hide driven by pending events
(follow `tests/desktop-chatParity.test.ts` patterns).

## B. `/theme` applies immediately in GUI and TUI

Root causes found:
- TUI: `Buffer.takeCommitRows` (`src/ui/buffer.ts:43`) lays out each item
  once into terminal scrollback and never re-renders it, so only rows printed
  after `/theme` pick up the new theme. `setTheme`
  (`src/ui/nativeApp.ts:421`) calls `recompute()` but never recommits.
- GUI: `desktop/renderer/style.css:1` hardcodes dark colors (no theme
  variables), and `buildGuiCommandContext` `setTheme`
  (`src/desktop/guiCommandContext.ts:173`) only persists the name with a
  "applies to the terminal UI" notice. Nothing notifies the renderer.

Design:
- TUI: `setTheme` calls `buffer.recommitAll()` plus a screen clear before
  `recompute()`, reusing the resize clear-and-reprint pattern
  (`src/ui/term/render.ts:231`). The whole transcript reprints in the new
  theme. Completions and overlay pick up `this.theme` via the existing
  `recompute()` path.
- GUI: add a `theme` chat event (`src/desktop/chatProtocol.ts`
  `CHAT_EVENT_TYPES` + `ChatEvent`). `guiCommandContext.setTheme` persists
  the name and emits it. The renderer listens, sets
  `document.documentElement.dataset.theme`, and persists to localStorage
  (same crash-safe pattern as `lastSelection.ts`). `style.css` extracts
  colors into CSS variables with one value set per theme name, reusing the
  `THEMES` keys so GUI/TUI names stay in sync.
- `/theme` completion and unknown-name handling stay as-is on both sides.

Tests: TUI recommit-on-theme unit test; GUI theme-event round-trip test;
parity test keeps `/theme` in the slash list.

## Non-goals

- No new backend protocol beyond the single `theme` event.
- No full mapping of every TUI theme role to CSS on day one; variable sets
  cover background/text/accent/muted/error first.
- No TUI scrollback recoloring of already-committed rows beyond the
  clear-and-reprint (scrollback above the viewport keeps old colors; same
  limitation as resize).
