import { Buffer } from "../buffer.js";
import { renderStatusBar, type StatusBarProps } from "../widgets/statusBar.js";
import { renderWorkInd } from "../widgets/workInd.js";
import { renderProgress } from "../widgets/progress.js";
import type { InputBoxRender } from "../widgets/inputBox.js";
import type { OverlayMode } from "../widgets/overlay.js";
import { tailForHeight } from "../streamTail.js";
import { CLEAR_AND_HOME, cursorTo } from "./ansi.js";
import type { Theme } from "../theme.js";

export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  activeTool?: string;
  compactPct?: number;
  scrollOffset: number | null;
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}

export function render(
  buffer: Buffer,
  scrollOffset: number | null,
  bottom: BottomState,
  theme: Theme,
  size: { rows: number; columns: number },
  viewOffset: number | null = scrollOffset
): string {
  const { rows, columns } = size;

  // Footer region, built bottom-up so its total height is known before the
  // transcript region's height is computed.
  const footerRows: string[] = [];
  footerRows.push(renderStatusBar({ ...bottom.statusBarProps, scrollHint: scrollOffset !== null }, theme, columns));
  if (bottom.overlay !== "none") {
    footerRows.unshift(...bottom.overlayRows);
  } else {
    footerRows.unshift(...bottom.inputRender.menuRows);
    if (bottom.inputRender.hintRow !== null) footerRows.unshift(bottom.inputRender.hintRow);
    footerRows.unshift(...bottom.inputRender.contentRows);
    footerRows.unshift(...bottom.inputRender.borderRows);
  }
  if (bottom.compactPct !== undefined) footerRows.unshift(renderProgress("Compacting", bottom.compactPct, theme, 20));
  if (bottom.streaming) footerRows.unshift(renderWorkInd(bottom.workIndFrame, bottom.activeTool ? `Running ${bottom.activeTool}` : "Thinking", Date.now() - bottom.workStartedAt, theme));
  if (bottom.streamingText !== "") {
    const streamTailCap = Math.max(3, rows - footerRows.length - 3);
    const tail = tailForHeight(bottom.streamingText, streamTailCap, columns);
    footerRows.unshift(...tail.split("\n"));
  }

  const footerHeight = Math.min(rows, footerRows.length);
  const visibleFooter = footerRows.slice(footerRows.length - footerHeight);
  const transcriptHeight = Math.max(0, rows - footerHeight);

  const { rows: transcriptRows } = buffer.visibleWindow(viewOffset, transcriptHeight, columns, theme);

  const out: string[] = [CLEAR_AND_HOME];
  transcriptRows.forEach((row, i) => {
    out.push(cursorTo(i + 1, 1) + row);
  });
  const footerStartRow = rows - footerHeight + 1;
  visibleFooter.forEach((row, i) => {
    out.push(cursorTo(footerStartRow + i, 1) + row);
  });
  return out.join("");
}
