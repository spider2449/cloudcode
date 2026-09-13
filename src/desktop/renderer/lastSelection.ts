// Persists the GUI's last active project + session pair so a relaunch can
// resume where the user left off. Pure functions only (no React, no window)
// so the node-based unit tests can import this module directly.

// A null sessionId means the workspace was left on an anonymous New session.
export interface StoredSelection {
  workspaceId: string;
  sessionId: string | null;
}

// Structural minimum of the renderer's Workspace type.
export interface RestorableWorkspace {
  id: string;
  sessions: Array<{ id: string }>;
}

export const LAST_SELECTION_KEY = "cloudcode.lastSelection";

// Parses a stored value; anything missing or malformed yields undefined so
// the caller falls back to the default first-project/first-session flow.
export function parseStoredSelection(raw: string | null): StoredSelection | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { workspaceId, sessionId } = parsed as Record<string, unknown>;
    if (typeof workspaceId !== "string" || workspaceId === "") return undefined;
    if (sessionId !== null && typeof sessionId !== "string") return undefined;
    return { workspaceId, sessionId };
  } catch {
    return undefined;
  }
}

// Reads through an injected getter so storage failures (private mode, quota)
// stay the caller's concern; any failure yields undefined (default flow).
export function loadStoredSelection(read: () => string | null): StoredSelection | undefined {
  try {
    return parseStoredSelection(read());
  } catch {
    return undefined;
  }
}

// Picks the launch selection: today's defaults everywhere, except the
// remembered workspace (when it still exists) opens its remembered session —
// null for an anonymous New session, or the first session when the remembered
// one is gone.
export function resolveRestoredSelection<W extends RestorableWorkspace>(
  workspaces: W[],
  stored: StoredSelection | undefined
): { active: string | undefined; activeSessions: Record<string, string | undefined> } {
  const activeSessions: Record<string, string | undefined> = Object.fromEntries(
    workspaces.map(workspace => [workspace.id, workspace.sessions[0]?.id])
  );
  const target = (stored && workspaces.find(workspace => workspace.id === stored.workspaceId)) ?? workspaces[0];
  if (!target) return { active: undefined, activeSessions };
  if (stored && target.id === stored.workspaceId) {
    activeSessions[target.id] =
      stored.sessionId === null || target.sessions.some(session => session.id === stored.sessionId)
        ? stored.sessionId ?? undefined
        : target.sessions[0]?.id;
  }
  return { active: target.id, activeSessions };
}

// Serializes the live selection; unknown/anonymous sessions become null so a
// later parse either restores them or falls back to the default flow.
export function serializeSelection(
  active: string | undefined,
  activeSessions: Record<string, string | undefined>
): string {
  return JSON.stringify({
    workspaceId: active ?? null,
    sessionId: active ? (activeSessions[active] ?? null) : null
  });
}
