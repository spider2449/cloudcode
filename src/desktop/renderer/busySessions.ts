// Tracks which sessions have a running LLM turn so the shell can mark busy
// sessions in the sidebar and warn before abandoning a repo mid-turn.
// Keyed by chat request id (the only turn correlation the backend emits):
// ownership is recorded when the shell sends and released on turn end
// (done/error) or backend death. Node-importable for unit tests (same
// pattern as lastSelection.ts); the shell keeps the state itself.

export interface BusyTurnOwner {
  workspaceId: string | undefined;
  sessionId: string | undefined;
}

export type BusyTurns = Record<string, BusyTurnOwner>;

export function trackTurnStart(turns: BusyTurns, id: string, owner: BusyTurnOwner): BusyTurns {
  return { ...turns, [id]: owner };
}

export function trackTurnEnd(turns: BusyTurns, id: string): BusyTurns {
  if (!(id in turns)) return turns;
  const next = { ...turns };
  delete next[id];
  return next;
}

// Anonymous turns start without a session id and are adopted once they have
// content; move their ownership so the sidebar keeps marking them busy.
export function migrateAdoptedSession(turns: BusyTurns, workspaceId: string, adoptedId: string): BusyTurns {
  let changed = false;
  const next: BusyTurns = {};
  for (const [id, owner] of Object.entries(turns)) {
    if (owner.workspaceId === workspaceId && owner.sessionId === undefined) {
      next[id] = { workspaceId, sessionId: adoptedId };
      changed = true;
    } else {
      next[id] = owner;
    }
  }
  return changed ? next : turns;
}

export function isSessionBusy(turns: BusyTurns, workspaceId: string, sessionId: string): boolean {
  return Object.values(turns).some(
    owner => owner.workspaceId === workspaceId && owner.sessionId === sessionId
  );
}

// Turns still running in the repo being left (repo isolation): switching
// projects should confirm instead of silently abandoning them. Turns with
// no workspace attribution cannot be attributed and are not counted.
export function countBusyInWorkspace(turns: BusyTurns, workspaceId: string | undefined): number {
  if (workspaceId === undefined) return 0;
  return Object.values(turns).filter(owner => owner.workspaceId === workspaceId).length;
}
