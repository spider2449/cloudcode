import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { wrapText } from "../layout.js";
import { ERASE_DOWN, cursorTo, setScrollRegion, RESET_SCROLL_REGION, CLEAR_ALL_AND_HOME, sgr, SGR_RESET } from "./ansi.js";
import type { Theme } from "../theme.js";
import { appendFileSync } from "node:fs";

// Opt-in internal-state trace for diagnosing the redraw-in-place mechanism
// (Tasks 9a/9b/9c) directly, instead of inferring printedRows/onScreen from
// raw escape codes. Set CLOUDCODE_DEBUG_LOG to a file path (same variable
// terminal.ts's raw-output capture uses) to also get one line per frame()
// call showing the exact size/region/cache state at each step.
function traceLog(line: string): void {
  const path = process.env.CLOUDCODE_DEBUG_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `[${Date.now()}] RENDER ${line}\n`);
  } catch {
    // ignore
  }
}

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  thinkingText: string;
  activeTool?: string;
  compactPct?: number;
  // Muted, width-truncated rows for messages queued while streaming; drawn
  // directly above the input divider.
  queuedRows: string[];
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}

/**
 * Claude Code-style inline renderer with a pinned-bottom footer. The
 * transcript lives in a terminal scroll region (rows 1..scrollBottom) that
 * the terminal itself scrolls, pushing lines that leave the top into native
 * scrollback for selection/copy/wheel-scroll. The footer band below it
 * (scrollBottom+1..rows) is repainted every frame with cursor addressing
 * confined to those rows, so it stays pinned to the bottom edge.
 */
export class InlineRenderer {
  // -1 means "no region defined yet" (first frame after construction or
  // after invalidate()).
  private lastScrollBottom = -1;
  private lastRows = -1;
  private lastColumns = -1;
  // Cumulative count of transcript rows printed since the region was last
  // invalidated, and a bounded cache of their text, used to redraw
  // currently-visible content directly (no terminal scrolling) when the
  // footer grows and everything on screen still fits the new, smaller
  // region -- see the shrink branch in frame() below.
  private printedRows = 0;
  private recentRows: string[] = [];
  private static readonly RECENT_ROWS_CAP = 1000;

  frame(
    buffer: Buffer,
    bottom: BottomState,
    theme: Theme,
    size: { rows: number; columns: number }
  ): string {
    const { rows, columns } = size;

    // Footer content, built bottom-up (same assembly as before).
    const dyn: string[] = [];
    dyn.push(...renderStatusBar(bottom.statusBarProps, theme, columns));
    if (bottom.overlay !== "none") {
      dyn.unshift(...bottom.overlayRows);
    } else {
      dyn.unshift(...bottom.inputRender.menuRows);
      if (bottom.inputRender.hintRow !== null) dyn.unshift(bottom.inputRender.hintRow);
      dyn.unshift(...bottom.inputRender.contentRows);
      dyn.unshift(...bottom.inputRender.borderRows);
      dyn.unshift(...bottom.queuedRows);
    }
    if (bottom.compactPct !== undefined) dyn.unshift(renderProgress("Compacting", bottom.compactPct, theme, 20));
    if (bottom.streaming) dyn.unshift(renderWorkInd(bottom.workIndFrame, bottom.activeTool ? `Running ${bottom.activeTool}` : "Thinking", Date.now() - bottom.workStartedAt, theme));
    // Tail lines are hard-wrapped to the terminal width instead of relying on
    // autowrap-off (CSI ?7l): legacy conhost ignores DECAWM, so an over-width
    // row written at the bottom of the screen wraps, scrolls the viewport, and
    // strands stale footer copies in the transcript region.
    if (bottom.streamingText !== "") {
      const streamTailCap = Math.max(3, rows - dyn.length - 3);
      dyn.unshift(...wrapText(tailForHeight(bottom.streamingText, streamTailCap, columns), columns));
    }
    if (bottom.thinkingText !== "") {
      const thinkTailCap = Math.max(2, Math.min(6, rows - dyn.length - 3));
      const thinkingCode = sgr(theme.thinking);
      const lines = wrapText(tailForHeight(bottom.thinkingText, thinkTailCap, Math.max(1, columns - 2)), Math.max(1, columns - 2));
      dyn.unshift(...lines.map((l, i) => `${thinkingCode}${i === 0 ? "○ " : "  "}${l}${SGR_RESET}`));
    }

    // Cap the footer so the scroll region always keeps at least 1 row.
    const footer = dyn.slice(Math.max(0, dyn.length - (rows - 1)));
    const scrollBottom = Math.max(1, rows - footer.length);

    let out = "";
    const firstFrame = this.lastScrollBottom < 0;
    const columnsChanged = columns !== this.lastColumns;
    const rowsChanged = rows !== this.lastRows;

    traceLog(
      `entry rows=${rows} columns=${columns} lastRows=${this.lastRows} lastColumns=${this.lastColumns} ` +
      `lastScrollBottom=${this.lastScrollBottom} scrollBottom=${scrollBottom} printedRows=${this.printedRows} ` +
      `recentRows.length=${this.recentRows.length} firstFrame=${firstFrame} columnsChanged=${columnsChanged} rowsChanged=${rowsChanged}`
    );

    if (columnsChanged) {
      // Cached row strings were wrapped for the OLD column width and would
      // render incorrectly (wrong wrap points) if redrawn at the new one.
      // nativeApp.ts's handleResize already detects width changes and
      // performs a debounced full buffer.recommitAll() + screen clear to
      // re-lay-out the whole transcript correctly at the new width; until
      // that lands, drop the stale cache rather than risk redrawing
      // garbled content -- the brief blank interval this creates is the
      // same interim tradeoff the app already makes for width changes.
      this.printedRows = 0;
      this.recentRows = [];
    }

    if (
      !firstFrame && !columnsChanged && !rowsChanged &&
      scrollBottom > this.lastScrollBottom &&
      this.printedRows > this.lastScrollBottom - 1
    ) {
      // Region growing back (footer collapsing, e.g. a streaming/thinking
      // preview ending) while part of the transcript has already scrolled
      // into native scrollback through the old, smaller region. A bottom-
      // anchored redraw here would leave a band of blank rows above the few
      // redrawn rows, and the very next commits (typically the full response
      // landing in this same frame) would scroll that blank band into
      // scrollback -- a permanent gap between the earlier transcript and the
      // new content. The scrollback rows can't be repositioned by escape
      // codes, so do what the resize path does: wipe screen + scrollback and
      // recommit the whole transcript contiguously.
      out += CLEAR_ALL_AND_HOME;
      this.printedRows = 0;
      this.recentRows = [];
      buffer.recommitAll();
    } else if (!firstFrame && !columnsChanged && scrollBottom !== this.lastScrollBottom) {
      const onScreen = Math.min(this.printedRows, Math.max(0, this.lastScrollBottom - 1));
      traceLog(`redraw-check onScreen=${onScreen} scrollBottom-1=${scrollBottom - 1} branch=${onScreen <= scrollBottom - 1 ? "redraw" : "evacuate"}`);
      if (onScreen <= scrollBottom - 1) {
        // Every row of transcript content currently on screen fits inside
        // the new region (whether it grew or shrank): redraw it directly
        // at its new bottom-anchored position via absolute cursor
        // addressing instead of leaving it in place or relocating it with
        // a terminal scroll. Two distinct bugs are avoided this way: (a)
        // shrinking via a raw scroll bakes mostly-blank filler into
        // scrollback as a visible burst of empty lines when little content
        // has been committed yet; (b) growing without repositioning leaves
        // existing content stranded near the old (smaller) scrollBottom
        // while new commits print at the far-away new one, opening a
        // visible gap of blank, erased rows in between. This now also
        // covers real terminal resizes (a window dragged taller/shorter),
        // not just footer-only changes at a fixed terminal size -- a rows-
        // only resize doesn't invalidate recentRows' wrap width, so the
        // same mechanism that fixed the footer-growth/shrink-back bugs
        // applies unchanged here. Without this, on-screen content stays
        // frozen at its old screen position while the region boundary
        // silently moves underneath it, and a resize *storm* (many resize
        // events per drag) repeats that mismatch on every tick -- producing
        // visible gaps, duplicated/ghost content, and stacked stale footer
        // rows.
        out += cursorTo(1, 1) + ERASE_DOWN;
        if (onScreen > 0) {
          const tail = this.recentRows.slice(-onScreen);
          out += cursorTo(scrollBottom - onScreen, 1) + tail.join("\r\n") + "\r\n";
        }
      } else {
        // Only reachable when shrinking: more content is on screen than
        // the new (smaller) region can hold. Growing a region can never
        // hit this branch, since onScreen was already bounded by the
        // smaller old region's own capacity. The excess rows have never
        // been scrolled into native scrollback (only ever drawn on
        // screen), so they must reach scrollback now -- but NOT via a raw
        // region scroll of (lastScrollBottom - scrollBottom) rows: when the
        // footer jumps by many rows in one frame (a large first streaming/
        // thinking chunk, or an overlay opening) while the content only
        // partially fills the old region, that scroll pushes all the blank
        // rows sitting above the content into native scrollback, baking a
        // permanent blank gap into the transcript. Instead: erase the
        // screen, set the new (smaller) region immediately, and re-print
        // the cached on-screen rows through it, so exactly the rows that
        // do not fit scroll into scrollback and nothing else does.
        out += cursorTo(1, 1) + ERASE_DOWN + setScrollRegion(1, scrollBottom);
        const tail = this.recentRows.slice(-onScreen);
        out += cursorTo(scrollBottom, 1) + tail.map(r => r + "\r\n").join("");
      }
    }

    if (firstFrame || columnsChanged || rowsChanged || scrollBottom !== this.lastScrollBottom) {
      out += setScrollRegion(1, scrollBottom);
      this.lastScrollBottom = scrollBottom;
      this.lastRows = rows;
      this.lastColumns = columns;
    }

    const staticRows = buffer.takeCommitRows(columns, theme);
    if (staticRows.length > 0) {
      this.printedRows += staticRows.length;
      this.recentRows.push(...staticRows);
      if (this.recentRows.length > InlineRenderer.RECENT_ROWS_CAP) {
        this.recentRows = this.recentRows.slice(-InlineRenderer.RECENT_ROWS_CAP);
      }
      traceLog(`commit staticRows.length=${staticRows.length} printedRows(after)=${this.printedRows} recentRows.length(after)=${this.recentRows.length}`);
    }
    out += cursorTo(scrollBottom, 1) + staticRows.map(r => r + "\r\n").join("");
    out += cursorTo(scrollBottom + 1, 1) + ERASE_DOWN + footer.join("\r\n");
    return out;
  }

  invalidate(): void {
    traceLog("invalidate() called");
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    this.printedRows = 0;
    this.recentRows = [];
  }

  finalize(): string {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    this.printedRows = 0;
    this.recentRows = [];
    return RESET_SCROLL_REGION + "\r\n";
  }
}
