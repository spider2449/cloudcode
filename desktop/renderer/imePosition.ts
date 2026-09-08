import type { Terminal } from "@xterm/xterm";

export interface ImeAnchor {
  left: number;
  top: number;
  height: number;
}

/**
 * Locate xterm's browser textarea at the visible terminal cursor cell.
 *
 * xterm's public cursorY is relative to baseY (0 when the cursor is at
 * baseY) while viewportY is the absolute buffer line of the viewport top,
 * so the visible row is cursorY + baseY - viewportY. Omitting baseY parks
 * the textarea at row 0 in any session with scrollback.
 */
export function imeAnchor(
  cursorX: number,
  cursorY: number,
  viewportY: number,
  columns: number,
  rows: number,
  screenWidth: number,
  screenHeight: number,
  baseY = 0
): ImeAnchor {
  const cellWidth = screenWidth / Math.max(1, columns);
  const cellHeight = screenHeight / Math.max(1, rows);
  const visibleRow = cursorY + baseY - viewportY;
  return {
    left: Math.min(Math.max(0, cursorX), Math.max(0, columns - 1)) * cellWidth,
    top: Math.min(Math.max(0, visibleRow), Math.max(0, rows - 1)) * cellHeight,
    height: cellHeight
  };
}

/**
 * Pick the element to measure cell size from. `.xterm-screen` has no in-flow
 * content (its canvas children are absolutely positioned), so its
 * clientHeight collapses to 0 and yields a degenerate 0-height anchor.
 * The canvas itself carries the real terminal layout size.
 */
export function pickMeasureElement(host: { querySelector(selectors: string): HTMLElement | null }): HTMLElement | null {
  return host.querySelector(".xterm-screen canvas") ?? host.querySelector(".xterm-screen");
}

export interface InputCell {
  row: number;
  col: number;
}

export interface InputCellScan {
  /** Last complete input-cell OSC in this chunk, if any. */
  cell: InputCell | undefined;
  /** True when the chunk clears the screen: drop any stored cell. */
  cleared: boolean;
  /** Possibly-split trailing OSC prefix to prepend to the next chunk. */
  pending: string;
}

const OSC_PREFIX_CAP = 40;

/**
 * Scan a stream chunk for TUI input-cell OSCs (`ESC ] 6973;input;row;col BEL`).
 * Scan-only: chunks pass through untouched. A split trailing OSC is returned
 * as pending (the TUI re-emits every parked frame, so a missed split heals
 * on the next frame even if pending were dropped).
 */
export function scanInputCell(chunk: string, pending: string): InputCellScan {
  const text = pending + chunk;
  const re = /\x1b\]6973;input;(\d+);(\d+)\x07/g;
  let cell: InputCell | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    cell = { row: Number(m[1]), col: Number(m[2]) };
  }
  let nextPending = "";
  const tailFrom = text.lastIndexOf("\x1b");
  if (tailFrom >= 0) {
    const tail = text.slice(tailFrom);
    if (tail.startsWith("\x1b]") && !tail.includes("\x07") && tail.length < OSC_PREFIX_CAP) {
      nextPending = tail;
    }
  }
  return { cell, cleared: text.includes("\x1b[2J"), pending: nextPending };
}

/**
 * xterm 6.0 does not move its hidden textarea until `compositionupdate`.
 * Windows chooses the IME candidate-window anchor at `compositionstart`, so
 * the first composition can otherwise inherit the textarea's off-screen
 * position and appear at the lower-right corner of the desktop window.
 */
export function installImeCursorSync(terminal: Terminal, host: HTMLElement): () => void {
  // Last TUI-authored input cell seen in the stream (zero-based screen row
  // and column). Authoritative: it is emitted alongside every parked frame,
  // so unlike the xterm cursor it cannot drift out of band.
  let authoritative: InputCell | undefined;
  let pendingOsc = "";

  // Restore the TUI's intended hidden-cursor presentation. The TUI hides the
  // physical cursor at startup, but ConPTY consumes the hide sequence instead
  // of forwarding it, so xterm's cursor stays visible (harmless while it
  // overlaps the drawn input marker, a stray block when drifted elsewhere).
  // Local-only write: never reaches the PTY. xterm's clear() preserves
  // cursor-visibility modes, so one write at install lasts the lifetime.
  terminal.write("\x1b[?25l");

  // Sniff the post-ConPTY stream for input-cell OSCs. Scan-only: data flows
  // through untouched (xterm ignores the unknown OSC either way).
  const origWrite = terminal.write.bind(terminal);
  terminal.write = ((data: string | Uint8Array, callback?: () => void): void => {
    if (typeof data === "string") {
      const scanned = scanInputCell(data, pendingOsc);
      pendingOsc = scanned.pending;
      if (scanned.cleared) authoritative = undefined;
      if (scanned.cell) authoritative = scanned.cell;
    }
    origWrite(data, callback);
  }) as typeof terminal.write;

  const sync = (): void => {
    const textarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const measure = pickMeasureElement(host);
    if (!textarea || !measure) return;

    const cellWidth = measure.clientWidth / Math.max(1, terminal.cols);
    const cellHeight = measure.clientHeight / Math.max(1, terminal.rows);
    if (authoritative) {
      // Deterministic path: enforce the authoritative cell locally (xterm
      // only — this write never reaches the PTY) so xterm's own view,
      // textarea and cursor machinery all follow it, whatever drifted.
      // Screen rows match viewport rows while following the tail, which
      // holds whenever the user can see the input to compose into it.
      const row = Math.min(Math.max(0, authoritative.row), Math.max(0, terminal.rows - 1));
      const col = Math.min(Math.max(0, authoritative.col), Math.max(0, terminal.cols - 1));
      terminal.write(`\x1b[${row + 1};${col + 1}H`);
      textarea.style.left = `${col * cellWidth}px`;
      textarea.style.top = `${row * cellHeight}px`;
      textarea.style.width = "1px";
      textarea.style.height = `${cellHeight}px`;
      textarea.style.lineHeight = `${cellHeight}px`;
      return;
    }

    const buffer = terminal.buffer.active;
    const anchor = imeAnchor(
      buffer.cursorX,
      buffer.cursorY,
      buffer.viewportY,
      terminal.cols,
      terminal.rows,
      measure.clientWidth,
      measure.clientHeight,
      buffer.baseY
    );
    textarea.style.left = `${anchor.left}px`;
    textarea.style.top = `${anchor.top}px`;
    textarea.style.width = "1px";
    textarea.style.height = `${anchor.height}px`;
    textarea.style.lineHeight = `${anchor.height}px`;
  };

  // Capture runs before xterm's listener on the helper textarea.
  host.addEventListener("compositionstart", sync, true);
  return () => {
    host.removeEventListener("compositionstart", sync, true);
    terminal.write = origWrite;
  };
}
