import type { Terminal } from "@xterm/xterm";

export interface ImeAnchor {
  left: number;
  top: number;
  height: number;
}

/** Locate xterm's browser textarea at the visible terminal cursor cell. */
export function imeAnchor(
  cursorX: number,
  cursorY: number,
  viewportY: number,
  columns: number,
  rows: number,
  screenWidth: number,
  screenHeight: number
): ImeAnchor {
  const cellWidth = screenWidth / Math.max(1, columns);
  const cellHeight = screenHeight / Math.max(1, rows);
  return {
    left: Math.min(Math.max(0, cursorX), Math.max(0, columns - 1)) * cellWidth,
    top: Math.min(Math.max(0, cursorY - viewportY), Math.max(0, rows - 1)) * cellHeight,
    height: cellHeight
  };
}

/**
 * xterm 6.0 does not move its hidden textarea until `compositionupdate`.
 * Windows chooses the IME candidate-window anchor at `compositionstart`, so
 * the first composition can otherwise inherit the textarea's off-screen
 * position and appear at the lower-right corner of the desktop window.
 */
export function installImeCursorSync(terminal: Terminal, host: HTMLElement): () => void {
  const sync = (): void => {
    const textarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!textarea || !screen) return;

    const buffer = terminal.buffer.active;
    const anchor = imeAnchor(
      buffer.cursorX,
      buffer.cursorY,
      buffer.viewportY,
      terminal.cols,
      terminal.rows,
      screen.clientWidth,
      screen.clientHeight
    );
    textarea.style.left = `${anchor.left}px`;
    textarea.style.top = `${anchor.top}px`;
    textarea.style.width = "1px";
    textarea.style.height = `${anchor.height}px`;
    textarea.style.lineHeight = `${anchor.height}px`;
  };

  // Capture runs before xterm's listener on the helper textarea.
  host.addEventListener("compositionstart", sync, true);
  return () => host.removeEventListener("compositionstart", sync, true);
}
