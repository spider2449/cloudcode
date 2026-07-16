import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { wrapText } from "../layout.js";
import { ERASE_DOWN, cursorTo, setScrollRegion, RESET_SCROLL_REGION, sgr, SGR_RESET } from "./ansi.js";
import type { Theme } from "../theme.js";

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  thinkingText: string;
  activeTool?: string;
  compactPct?: number;
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
      dyn.unshift(...lines.map((l, i) => `\x1b[2m${thinkingCode}${i === 0 ? "○ " : "  "}${l}${SGR_RESET}\x1b[22m`));
    }

    // Cap the footer so the scroll region always keeps at least 1 row.
    const footer = dyn.slice(Math.max(0, dyn.length - (rows - 1)));
    const scrollBottom = Math.max(1, rows - footer.length);

    let out = "";
    const firstFrame = this.lastScrollBottom < 0;
    const sizeChanged = rows !== this.lastRows || columns !== this.lastColumns;

    if (!firstFrame && !sizeChanged && scrollBottom !== this.lastScrollBottom) {
      const onScreen = Math.min(this.printedRows, Math.max(0, this.lastScrollBottom - 1));
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
        // visible gap of blank, erased rows in between.
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
        // screen), so they must be relocated via a real scroll.
        const evacuate = this.lastScrollBottom - scrollBottom;
        out += cursorTo(this.lastScrollBottom, 1) + "\r\n".repeat(evacuate);
      }
    }

    if (firstFrame || sizeChanged || scrollBottom !== this.lastScrollBottom) {
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
    }
    out += cursorTo(scrollBottom, 1) + staticRows.map(r => r + "\r\n").join("");
    out += cursorTo(scrollBottom + 1, 1) + ERASE_DOWN + footer.join("\r\n");
    return out;
  }

  invalidate(): void {
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
