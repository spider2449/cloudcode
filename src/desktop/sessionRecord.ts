import type { SessionIndex } from "../agent/sessionIndex.js";

// Desktop GUI persistence: mirrors the terminal UI (nativeApp sendUserMessage
// + printMode onSessionId). The first turn for a backend session id records
// the index entry (first user text becomes firstMessage); later turns only
// touch the entry so the sidebar stays ordered by recent use. Turns that fire
// before the session id is assigned carry nothing to persist.
export function recordGuiTurn(
  index: SessionIndex,
  turn: { cwd: string; provider: string; sessionId: string | undefined; text: string }
): void {
  if (turn.sessionId === undefined) return;
  const known = index.list().some(entry => entry.id === turn.sessionId);
  if (!known) {
    index.record({
      id: turn.sessionId,
      cwd: turn.cwd,
      firstMessage: turn.text,
      timestamp: new Date().toISOString(),
      provider: turn.provider
    });
    return;
  }
  index.touch(turn.sessionId);
}
