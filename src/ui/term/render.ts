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

    if (!firstFrame && !sizeChanged && scrollBottom < this.lastScrollBottom) {
      // Footer is growing: evacuate the rows about to become footer into
      // native scrollback by scrolling the OLD region before shrinking it,
      // so already-committed transcript lines aren't silently overwritten.
      const evacuate = this.lastScrollBottom - scrollBottom;
      out += cursorTo(this.lastScrollBottom, 1) + "\r\n".repeat(evacuate);
    }

    if (firstFrame || sizeChanged || scrollBottom !== this.lastScrollBottom) {
      if (!firstFrame && scrollBottom > this.lastScrollBottom) {
        // Footer is shrinking (or the window grew): the rows being freed
        // back to the message region still hold stale footer bytes.
        out += cursorTo(this.lastScrollBottom + 1, 1) + ERASE_DOWN;
      }
      out += setScrollRegion(1, scrollBottom);
      this.lastScrollBottom = scrollBottom;
      this.lastRows = rows;
      this.lastColumns = columns;
    }

    const staticRows = buffer.takeCommitRows(columns, theme);
    out += cursorTo(scrollBottom, 1) + staticRows.map(r => r + "\r\n").join("");
    out += cursorTo(scrollBottom + 1, 1) + ERASE_DOWN + footer.join("\r\n");
    return out;
  }

  invalidate(): void {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
  }

  finalize(): string {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    return RESET_SCROLL_REGION + "\r\n";
  }
}
