/** Turn-state markers for the desktop host.
 *
 * The embedded TUI writes these OSC sequences to its stdout on turn
 * boundaries. The Electron main process strips them from the PTY stream
 * (so they never render) and tracks a busy flag the renderer queries
 * before switching sessions.
 */
export const TURN_BUSY_MARKER = "\x1b]777;cloudcode-turn=busy\x07";
export const TURN_IDLE_MARKER = "\x1b]777;cloudcode-turn=idle\x07";

/** Remove turn markers from a PTY chunk; returns the visible remainder. */
export function stripTurnMarkers(chunk: string): string {
  if (!chunk.includes("\x1b]777;cloudcode-turn=")) return chunk;
  return chunk.split(TURN_BUSY_MARKER).join("").split(TURN_IDLE_MARKER).join("");
}

/** True when the chunk announces a turn start. */
export function chunkStartsTurn(chunk: string): boolean {
  return chunk.includes(TURN_BUSY_MARKER);
}

/** True when the chunk announces a turn end. */
export function chunkEndsTurn(chunk: string): boolean {
  return chunk.includes(TURN_IDLE_MARKER);
}
