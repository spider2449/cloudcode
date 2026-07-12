// The transcript renders through <Static> into terminal scrollback, outside
// Ink's layout tree, so its height cannot be measured with measureElement.
// Instead we estimate its rows with the same wrap math as streamTail.ts,
// mirroring how MessageList.renderItem shapes each item. This estimate only
// matters while total content is shorter than the terminal (the filler is 0
// otherwise), so small drift on exotic markdown is acceptable.
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function wrappedRows(line: string, columns: number): number {
  const width = Math.max(1, columns);
  const visible = line.replace(ANSI_RE, "").length;
  return Math.max(1, Math.ceil(visible / width));
}

// Exported so App.tsx can count rows of the already-capped stream tail
// (tailForHeight's output) using the same wrap math, instead of duplicating
// it, when building the live-region floor estimate.
export function textRows(text: string, columns: number): number {
  return text.split("\n").reduce((sum, line) => sum + wrappedRows(line, columns), 0);
}

export function itemRows(item: DisplayItem, columns: number): number {
  switch (item.kind) {
    case "user":
      return textRows("> " + item.text, columns);
    case "assistant":
      return textRows(renderMarkdown(item.text), columns);
    case "tool":
      return textRows("⏺ " + item.label, columns);
    case "notice":
    case "error":
      return textRows(item.text, columns);
    case "diff":
      return item.lines.reduce(
        (sum, l) => sum + wrappedRows(`${l.sign} ${l.text}`, Math.max(1, columns - 2)),
        0
      );
    case "result":
      return 1;
    default: {
      // Exhaustiveness guard: a future DisplayItem kind that isn't handled
      // above fails typecheck here instead of silently returning undefined.
      const _exhaustive: never = item;
      return 1;
    }
  }
}

export function staticRows(items: DisplayItem[], columns: number, cap: number): number {
  let rows = 0;
  for (const item of items) {
    rows += itemRows(item, columns);
    if (rows >= cap) return cap;
  }
  return rows;
}

// How many rows of headroom to leave between filler + live region and the
// terminal's bottom edge. The footer (StatusBar) is the LAST row of the
// live region, so a reserve of 0 pins it to the very bottom row; a reserve
// of 1 leaves it one row above. The reserve exists to prevent Ink's
// clearTerminal/scrollback-erasing repaint when a live-region element first
// appears and measureElement lags one render behind (its reported
// dynamicRows is stale-low that frame, so without a reserve filler + actual
// height can reach terminalRows). Callers should pass 1 during any frame
// where the live region is growing, shrinking, or being re-laid-out (stream
// tail present, streaming/compacting indicator visible, overlay open, or
// the measured dynamicRows has not caught up to the render-time floor), and
// 0 only in steady-state idle so the footer truly pins to the bottom.
export function fillerHeight(
  terminalRows: number,
  staticRows: number,
  dynamicRows: number,
  reserveRows = 1
): number {
  const reserve = Math.max(0, Math.floor(reserveRows));
  return Math.max(0, terminalRows - staticRows - dynamicRows - reserve);
}

// Resize-transition safety net. React effects (InputBox's onInputRowsChange
// re-sync on `[columns, disabled]`, and App.tsx's measureElement pass for
// dynamicRows) run one Ink render cycle AFTER commit, so for the single
// frame right after a terminal resize, both the measured dynamicRows and the
// live-region floor's inputRows still reflect the PRE-resize width while
// termSize already reflects the NEW width. If the transcript is short
// (post-/clear) and the input box already contains a long line that wraps
// differently at the new width, that stale floor can combine with the new
// (possibly smaller) terminalRows such that filler + actual height reaches
// terminalRows and triggers Ink's scrollback-erasing clearTerminal. Forcing
// filler to 0 for that one frame sidesteps the stale measurement entirely
// instead of trying to keep it in sync; the frame is visually a no-op (the
// footer just sits wherever content ends for a single frame).
export function resizeSafeFillerHeight(
  terminalRows: number,
  staticRows: number,
  dynamicRows: number,
  justResized: boolean,
  reserveRows = 1
): number {
  // A resize IS a growth/transition frame whose stale floor can be far below
  // the new real height (the input box wraps to MORE rows at the new narrower
  // width), so for that one frame the filler must be forced to 0 — even if
  // the caller is in steady-state idle (reserveRows=0) — so that
  // filler + real_height cannot reach terminalRows and trigger Ink's
  // clearTerminal/scrollback-erasing repaint. Once the just-resized frame has
  // passed, the caller's reserveRows is honored so steady-state idle pins the
  // footer to the very bottom row.
  if (justResized) return 0;
  return fillerHeight(terminalRows, staticRows, dynamicRows, reserveRows);
}

// The live region (stream tail, WorkingIndicator/ProgressBar, pickers,
// permission dialog, InputBox, StatusBar) is measured with measureElement
// AFTER render, so the frame in which it grows still renders with the
// previous (smaller) dynamicRows. If that frame's filler was sized against
// the stale value, filler + actual live region can reach terminalRows and
// trigger Ink's clearTerminal/scrollback-erasing repaint. liveRegionFloor is
// a synchronous, render-time LOWER BOUND on the live region's height, built
// from the same state App.tsx uses to decide what to render this frame (no
// lag). Callers should use Math.max(measuredDynamicRows, liveRegionFloor(...))
// so understimating never happens; overestimating only lifts the footer for
// a frame, which is the safe direction.
export interface LiveRegionState {
  streamRows: number;        // rows the stream tail occupies (0 if empty)
  streaming: boolean;        // WorkingIndicator visible
  compacting: boolean;       // ProgressBar visible
  inputRows: number;         // InputBox's exact rendered row count, 0 when hidden (see inputBoxRows)
  overlayRows: number;       // rows for ResumePicker/ProjectPicker/PermissionDialog when shown, else 0
}

export function liveRegionFloor(s: LiveRegionState): number {
  // StatusBar: 1 row (may wrap, but floor is fine)
  let rows = 1; // StatusBar
  rows += s.inputRows;
  if (s.streaming) rows += 1;
  if (s.compacting) rows += 1;
  rows += s.streamRows;
  rows += s.overlayRows;
  return rows;
}

// Exact row count of InputBox's own bordered box: 2 border rows
// (borderStyle="round", top+bottom) + wrapped rows of its rendered content,
// where the available width is `columns` minus the border's 2 side
// characters and its paddingX={1} on both sides (2 more columns) = columns
// - 4. `content` should be the exact string InputBox renders inside the
// Text child ("> " + before-cursor + cursor-glyph + after-cursor), so a
// literal newline from backtick-continuation or a line that word-wraps past
// the box width is counted precisely instead of assuming a flat 3 rows.
// Exported so InputBox can report this exact value to App.tsx via the same
// same-render-batch callback pattern used for the suggestion menu (see
// onMenuRowsChange doc comment below) instead of App.tsx guessing.
export function inputBoxRows(content: string, columns: number): number {
  return 2 + textRows(content, Math.max(1, columns - 4));
}

// A note on the InputBox suggestion menu (SuggestionMenu.tsx, up to
// MAX_ROWS=8 extra rows when typing "/" or "@"): its open/closed state and
// row count live in InputBox's local component state, not in anything
// App.tsx's render body can see synchronously, so liveRegionFloor above
// cannot model it as a per-flag addition the way it does streaming/
// compacting/overlays. Baking a flat "+8 whenever inputVisible" into the
// floor was considered and rejected: since the input is enabled through
// most of an idle session, that would keep the footer sitting permanently
// 8 rows off the bottom edge, defeating the bottom-anchoring feature.
// Instead, App.tsx lifts the EXACT current menu row count from InputBox via
// a same-render-batch callback (InputBox's onMenuRowsChange): Ink wraps
// every useInput handler in reconciler.batchedUpdates
// (node_modules/ink/build/hooks/use-input.js), so InputBox's own state
// update and the callback into App's setState land in the same React
// commit — no one-frame lag, unlike measureElement. This gives an exact
// value instead of a worst-case guess, so the footer only moves when the
// menu is actually open, and by exactly as much as it needs to.
