export interface TerminalKeyEvent {
  type: string;
  key: string;
  shiftKey: boolean;
}

/** Convert Enter keys to the Kitty sequences expected by the embedded TUI. */
export function terminalKeySequence(event: TerminalKeyEvent): string | undefined {
  if (event.type !== "keydown" || event.key !== "Enter") return undefined;
  return event.shiftKey ? "\x1b[13;2u" : "\x1b[13u";
}
