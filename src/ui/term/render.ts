import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { ERASE_DOWN, cursorUp } from "./ansi.js";
import type { Theme } from "../theme.js";

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  activeTool?: string;
  compactPct?: number;
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}

/**
 * Claude Code-style inline renderer. Transcript rows are printed once into
 * the terminal's normal scrollback and never touched again, so native mouse
 * selection, copy, and wheel scrolling work in the message area. Only the
 * dynamic bottom block (streaming tail, indicators, input box or overlay,
 * status bar) is repainted, using cursor-relative movement.
 */
export class InlineRenderer {
  // Number of lines the cursor must travel up to reach the first line of the
  // previously painted dynamic block (block height minus one, since the
  // cursor parks on the block's last line).
  private lastDynamicLines = 0;

  frame(
    buffer: Buffer,
    bottom: BottomState,
    theme: Theme,
    size: { rows: number; columns: number }
  ): string {
    const { rows, columns } = size;

    // Dynamic block, built bottom-up (same assembly as the old renderer).
    const dyn: string[] = [];
    dyn.push(renderStatusBar(bottom.statusBarProps, theme, columns));
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
    if (bottom.streamingText !== "") {
      const streamTailCap = Math.max(3, rows - dyn.length - 3);
      dyn.unshift(...tailForHeight(bottom.streamingText, streamTailCap, columns).split("\n"));
    }

    // Cap the block below the viewport height: moving the cursor up more
    // rows than the viewport has would corrupt the frame.
    const visible = dyn.slice(Math.max(0, dyn.length - (rows - 1)));

    const staticRows = buffer.takeCommitRows(columns, theme);
    const out =
      "\r" + cursorUp(this.lastDynamicLines) + ERASE_DOWN +
      staticRows.map(r => r + "\r\n").join("") +
      visible.join("\r\n");
    this.lastDynamicLines = Math.max(0, visible.length - 1);
    return out;
  }

  invalidate(): void {
    this.lastDynamicLines = 0;
  }

  finalize(): string {
    this.lastDynamicLines = 0;
    return "\r\n";
  }
}
