import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { VERSION } from "../../src/version.js";
import { ChatPane } from "./chatPane.js";
import {
  countBusyInWorkspace, isSessionBusy, migrateAdoptedSession,
  trackTurnEnd, trackTurnStart, type BusyTurns
} from "./busySessions.js";
import { dirtyRepoCount, groupSessionsByRepo, statusGitLabel } from "./workspaceView.js";
import { StatusBar, StatuslinePicker } from "./statusBar.js";
import type { DesktopStatusPayload } from "../../src/desktop/statusPayload.js";
import { ThemeMenu } from "./themeMenu.js";
import { LAST_SELECTION_KEY, loadStoredSelection, resolveRestoredSelection, serializeSelection } from "./lastSelection.js";
import type { ChatRequest, GitState, Session, Workspace } from "./bridge.js";
import { GitPanel, GitRepoCard } from "./gitPanel.js";

const DEFAULT_SIDEBAR_WIDTH = 260;
const DEFAULT_INSPECTOR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_INSPECTOR_WIDTH = 220;
const MAX_INSPECTOR_WIDTH = 560;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Scope key for per-repo state maps. Single-repo workspaces keep the plain
// workspace id (today's shape); multi-repo entries are namespaced per repo
// because positional repo ids (repo-0, ...) repeat across workspaces.
function repoScopeKey(workspaceId: string, repoId: string | undefined): string {
  return repoId === undefined ? workspaceId : `${workspaceId}:${repoId}`;
}

function loadStringRecord(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [entryKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[entryKey] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function loadBooleanRecord(key: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, boolean> = {};
    for (const [entryKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[entryKey] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string>();
  const [activeSessions, setActiveSessions] = useState<Record<string, string | undefined>>({});
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [gitStates, setGitStates] = useState<Record<string, GitState | undefined>>({});
  // Per-repo Git states for multi workspaces, keyed by repoScopeKey.
  const [multiGit, setMultiGit] = useState<Record<string, GitState | undefined>>({});
  // Last-used repo per workspace (multi only; single workspaces never set this
  // and keep the legacy wire shape with repoId undefined everywhere).
  // Clicking a repo header in the sidebar sets this explicitly; otherwise it
  // tracks the open session's repo. New sessions always open here.
  const [activeRepos, setActiveRepos] = useState<Record<string, string | undefined>>(() => loadStringRecord("cloudcode.activeRepos"));
  // Collapsed Git cards per repo scope, persisted across restarts.
  const [gitCollapsed, setGitCollapsed] = useState<Record<string, boolean>>(() => loadBooleanRecord("cloudcode.gitCollapsed"));
  const [backendExit, setBackendExit] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth("cloudcode.sidebarWidth", DEFAULT_SIDEBAR_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readStoredWidth("cloudcode.inspectorWidth", DEFAULT_INSPECTOR_WIDTH));
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  const [status, setStatus] = useState<DesktopStatusPayload | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  // In-flight turns by request id (recorded on send, released on turn end).
  // Background sessions keep running across switches; the sidebar marks
  // them busy and leaving their repo asks for confirmation.
  const [busyTurns, setBusyTurns] = useState<BusyTurns>({});
  const dragState = useRef<{ side: "left" | "right"; startX: number; startSidebar: number; startInspector: number } | null>(null);
  const lastChat = useRef<ChatRequest | undefined>(undefined);
  // Set once the initial restore resolves; the persist effect below must not
  // run before that, or a slow restore would clobber the remembered value.
  const restoredRef = useRef(false);
  const activeWorkspace = workspaces.find(workspace => workspace.id === active);
  const workspaceRef = useRef(activeWorkspace);
  workspaceRef.current = activeWorkspace;

  // Only the reserved backend id reports process exits; turn failures from
  // any other id render as error bubbles in the chat pane. A recovered
  // stream (text delta or turn completion) clears the banner again.
  useEffect(() => {
    return window.cloudcode.onChatEvent(event => {
      if (event.id === "backend" && event.type === "error") {
        setBackendExit(event.text ?? "Backend exited");
        // Backend death drops all of its in-memory turn state with it.
        setBusyTurns({});
      } else if (event.type === "text_delta" || event.type === "done") setBackendExit(undefined);
      // Turn end releases the sidebar busy mark, including turns running in
      // background sessions (their done arrives here, not in ChatPane).
      if (event.type === "done" || event.type === "error") {
        setBusyTurns(current => trackTurnEnd(current, event.id));
      }
    });
  }, []);

  // Global statusline: polls the gui-server backend for the active
  // conversation (cost/tokens/model/mode) and repaints on every turn event.
  // Git branch comes from the existing gitStates poll, overlaid at render.
  const activeSessionId = active !== undefined ? activeSessions[active] : undefined;
  const activeSession = activeWorkspace?.sessions.find(session => session.id === activeSessionId);
  // Effective repo for multi workspaces: the active session's repo wins (keeps
  // chat, polling, and Git scoped together); otherwise the last-used repo,
  // otherwise the first repo. Single workspaces stay undefined (legacy wire).
  const chatRepoId = activeWorkspace?.kind !== "multi" ? undefined : (
    activeSession?.repoId
    ?? (active !== undefined ? activeRepos[active] : undefined)
    ?? activeWorkspace.repos[0]?.id
  );
  // New sessions open in the explicitly picked repo (sidebar header click),
  // else the open session's repo, else the first repo. Unlike chatRepoId
  // (which must stay on the open session's repo), the explicit pick wins.
  function newSessionTargetFor(workspaceId: string): string | undefined {
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (workspace?.kind !== "multi") return undefined;
    const session = workspace.sessions.find(item => item.id === activeSessions[workspaceId]);
    return activeRepos[workspaceId] ?? session?.repoId ?? workspace.repos[0]?.id;
  }
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let seq = 0;
    const poll = () => {
      const id = `status-${Date.now()}-${(seq += 1)}`;
      void window.cloudcode.chatStatus({ id, sessionId: activeSessionId, workspaceId: active, ...(chatRepoId === undefined ? {} : { repoId: chatRepoId }) }).catch(() => {});
      timer = window.setTimeout(poll, document.hidden ? 10_000 : 3_000);
    };
    poll();
    const off = window.cloudcode.onChatEvent(event => {
      const typed = event as { type: string; status?: DesktopStatusPayload };
      if (typed.type === "status" && typed.status && !disposed) setStatus(typed.status);
      else if (typed.type === "statusline_picker" && (typed as { status?: DesktopStatusPayload }).status && !disposed) {
        setStatus((typed as { status: DesktopStatusPayload }).status);
        setPickerOpen(true);
      } else if (!disposed && (typed.type === "done" || typed.type === "text_delta")) {
        const id = `status-${Date.now()}-${(seq += 1)}`;
        void window.cloudcode.chatStatus({ id, sessionId: activeSessionId, workspaceId: active, ...(chatRepoId === undefined ? {} : { repoId: chatRepoId }) }).catch(() => {});
      }
    });
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); off(); };
  }, [active, activeSessionId, chatRepoId]);

  useEffect(() => {
    void window.cloudcode.restoreProjects().then(restored => {
      setWorkspaces(restored);
      restoredRef.current = true;
      const resolved = resolveRestoredSelection(
        restored,
        loadStoredSelection(() => window.localStorage.getItem(LAST_SELECTION_KEY))
      );
      setActive(resolved.active);
      setActiveSessions(resolved.activeSessions);
    });
  }, []);

  // Remembers the last active pair on every switch (crash-safe). Failures are
  // ignored so the next launch simply falls back to the default selection.
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      window.localStorage.setItem(LAST_SELECTION_KEY, serializeSelection(active, activeSessions));
    } catch {
      // Storage unavailable: keep the previously stored value, if any.
    }
  }, [active, activeSessions]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const workspace = await window.cloudcode.refreshWorkspace(active);
        if (disposed) return;
        setWorkspaces(current => current.map(item => item.id === active ? workspace : item));
        if (workspace.kind === "multi") {
          const states = await window.cloudcode.gitStates(active);
          if (disposed) return;
          setMultiGit(current => {
            const next = { ...current };
            for (const [repoId, state] of Object.entries(states)) next[repoScopeKey(active, repoId)] = state;
            return next;
          });
        } else {
          const git = await window.cloudcode.gitState(active);
          if (disposed) return;
          setGitStates(current => ({ ...current, [active]: git }));
        }
      } catch (error) {
        if (disposed) return;
        const failure: GitState = { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false, recent: [], error: error instanceof Error ? error.message : String(error) };
        const known = workspaceRef.current;
        if (known?.kind === "multi") {
          setMultiGit(current => {
            const next = { ...current };
            for (const repo of known.repos) next[repoScopeKey(active, repo.id)] = failure;
            return next;
          });
        } else {
          setGitStates(current => ({ ...current, [active]: failure }));
        }
      } finally {
        if (!disposed) timer = window.setTimeout(refresh, document.hidden ? 10_000 : 3_000);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [active]);

  // Refresh every repo card of a multi workspace (single gitStates roundtrip).
  async function refreshMultiGit(workspaceId: string) {
    const states = await window.cloudcode.gitStates(workspaceId);
    setMultiGit(current => {
      const next = { ...current };
      for (const [repoId, state] of Object.entries(states)) next[repoScopeKey(workspaceId, repoId)] = state;
      return next;
    });
  }

  useEffect(() => {
    document.title = `CloudCode v${VERSION} — ${activeWorkspace?.name ?? "No project"}`;
  }, [activeWorkspace?.name]);

  useEffect(() => {
    try {
      window.localStorage.setItem("cloudcode.sidebarWidth", String(sidebarWidth));
    } catch {
      // ignore
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem("cloudcode.inspectorWidth", String(inspectorWidth));
    } catch {
      // ignore
    }
  }, [inspectorWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem("cloudcode.activeRepos", JSON.stringify(activeRepos));
    } catch {
      // ignore
    }
  }, [activeRepos]);

  useEffect(() => {
    try {
      window.localStorage.setItem("cloudcode.gitCollapsed", JSON.stringify(gitCollapsed));
    } catch {
      // ignore
    }
  }, [gitCollapsed]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const state = dragState.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      if (state.side === "left") {
        setSidebarWidth(clamp(state.startSidebar + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
      } else {
        setInspectorWidth(clamp(state.startInspector - delta, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH));
      }
    };
    const onUp = () => {
      dragState.current = null;
      setDragging(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging]);

  function beginResize(side: "left" | "right", event: ReactMouseEvent) {
    event.preventDefault();
    dragState.current = { side, startX: event.clientX, startSidebar: sidebarWidth, startInspector: inspectorWidth };
    setDragging(side);
  }

  function resetResize(side: "left" | "right") {
    if (side === "left") setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    else setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
  }

  const inspectorVisible = inspectorOpen && activeWorkspace !== undefined;
  const gridTemplateColumns = !sidebarOpen && !inspectorVisible
    ? "minmax(0, 1fr)"
    : sidebarOpen && inspectorVisible
      ? `${sidebarWidth}px 5px minmax(0, 1fr) 5px ${inspectorWidth}px`
      : sidebarOpen
        ? `${sidebarWidth}px 5px minmax(0, 1fr)`
        : `minmax(0, 1fr) 5px ${inspectorWidth}px`;

  function applyWorkspaceSwitch(nextId: string) {
    const leaving = workspaces.find(workspace => workspace.id === active);
    const target = workspaces.find(workspace => workspace.id === nextId);
    setActiveSessions(current => {
      const next = { ...current };
      if (leaving && next[leaving.id] === undefined && leaving.sessions[0]?.id !== undefined) {
        next[leaving.id] = leaving.sessions[0]?.id;
      }
      const stored = next[nextId];
      const known = target?.sessions.some(session => session.id === stored);
      if ((stored === undefined || !known) && target?.sessions[0]?.id !== undefined) {
        next[nextId] = target.sessions[0]?.id;
      }
      return next;
    });
    setActive(nextId);
  }

  // Repo isolation: leaving a project with running turns abandons them
  // out of sight, so it asks for confirmation. Same-repo session switches
  // stay silent (turns keep running, marked busy in the list).
  function confirmLeaveBusyRepo(): boolean {
    const leaving = countBusyInWorkspace(busyTurns, active);
    if (leaving === 0) return true;
    const name = activeWorkspace?.name ?? "this project";
    const turns = leaving === 1 ? "1 turn is" : `${leaving} turns are`;
    return window.confirm(`${turns} still running in "${name}". Switch projects anyway?`);
  }

  function switchWorkspace(nextId: string) {
    if (nextId === active) return;
    if (!confirmLeaveBusyRepo()) return;
    applyWorkspaceSwitch(nextId);
  }

  async function openProject() {
    const workspace = await window.cloudcode.openProject();
    if (!workspace) return;
    adoptWorkspace(workspace);
  }

  async function openWorkspaceFile() {
    const workspace = await window.cloudcode.openWorkspaceFile();
    if (!workspace) return;
    adoptWorkspace(workspace);
  }

  function adoptWorkspace(workspace: Workspace) {
    if (workspace.id !== active && !confirmLeaveBusyRepo()) return;
    setWorkspaces(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
    setActiveSessions(current => ({ ...current, [workspace.id]: workspace.sessions[0]?.id }));
    setActive(workspace.id);
  }

  // Attach a folder to the active workspace (single converts to an unsaved
  // multi in place). The backend returns the refreshed same-id workspace.
  async function attachRepo() {
    if (!active) return;
    const workspace = await window.cloudcode.attachRepo(active);
    if (!workspace) return;
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
  }

  async function saveWorkspaceAs() {
    if (!activeWorkspace || activeWorkspace.kind !== "multi" || activeWorkspace.saved) return;
    const workspace = await window.cloudcode.saveWorkspace(activeWorkspace.id, activeWorkspace.name);
    if (!workspace) return;
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
  }

  // File > Save Workspace As... (application menu): the main process cannot
  // know the active workspace, so it notifies here and the current save flow
  // runs (no-op unless an unsaved multi workspace is active).
  const saveWorkspaceRef = useRef(saveWorkspaceAs);
  saveWorkspaceRef.current = saveWorkspaceAs;
  useEffect(() => window.cloudcode.onMenuAction(payload => {
    if (payload?.action === "save-workspace") void saveWorkspaceRef.current();
  }), []);

  // Session switching no longer kills a live PTY, so no busy confirmation is needed.
  // Multi workspaces also remember the containing repo so chat, polling, and
  // Git stay scoped together (single workspaces pass no repoId).
  function selectSession(workspaceId: string, sessionId: string | undefined, repoId?: string) {
    if (repoId !== undefined) {
      setActiveRepos(current => (current[workspaceId] === repoId ? current : { ...current, [workspaceId]: repoId }));
    }
    if (activeSessions[workspaceId] === sessionId) return;
    setActiveSessions(current => ({ ...current, [workspaceId]: sessionId }));
  }

  async function submitRename(workspaceId: string, sessionId: string, title: string) {
    const trimmed = title.trim().slice(0, 200);
    setEditingId(undefined);
    if (!trimmed) return;
    const workspace = await window.cloudcode.renameSession(workspaceId, sessionId, trimmed);
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
  }

  async function deleteSession(workspaceId: string, sessionId: string) {
    if (!window.confirm("Delete this session? This removes it from the list and deletes its transcript.")) return;
    const workspace = await window.cloudcode.removeSession(workspaceId, sessionId);
    setWorkspaces(current => current.map(item => item.id === workspace.id ? workspace : item));
    setActiveSessions(current => {
      if (current[workspaceId] !== sessionId) return current;
      return { ...current, [workspaceId]: undefined };
    });
  }

  function retryLastChat() {
    const request = lastChat.current;
    if (!request) return;
    setBackendExit(undefined);
    void window.cloudcode.chatSend(request);
  }

  function renderSessionCard(workspace: Workspace, session: Session) {
    const repoId = workspace.kind === "multi" ? session.repoId : undefined;
    return <div key={session.id} className="session-item">{editingId === session.id ? <input className="session-edit-input" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submitRename(workspace.id, session.id, draft); else if (event.key === "Escape") setEditingId(undefined); }} onBlur={() => void submitRename(workspace.id, session.id, draft)} aria-label="Rename session" /> : <><button className={activeSessions[workspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(workspace.id, session.id, repoId)}><span className="session-title">{isSessionBusy(busyTurns, workspace.id, session.id) && <><span className="session-busy" title="Turn running" /> </>}{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button><span className="session-actions"><button title="Rename session" aria-label={`Rename ${session.firstMessage || "Untitled session"}`} onClick={() => { setEditingId(session.id); setDraft(session.firstMessage); }}>✎</button><button title="Delete session" aria-label={`Delete ${session.firstMessage || "Untitled session"}`} onClick={() => void deleteSession(workspace.id, session.id)}>🗑</button></span></>}</div>;
  }

  return <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorVisible ? "" : "inspector-collapsed"}${dragging ? " resizing" : ""}`} style={{ gridTemplateColumns }}>
    {sidebarOpen && <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><span className="brand-mark">C</span><span>CloudCode</span><span className="brand-version">v{VERSION}</span></div><button className="icon-button" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button></div>
      <button className="new-session" disabled={!active} onClick={() => active && selectSession(active, undefined, active !== undefined ? newSessionTargetFor(active) : undefined)}><span>＋</span> New session <kbd>Ctrl N</kbd></button>
      <div className="project-switcher"><span>⌘</span><select aria-label="Active project" value={active ?? ""} onChange={event => switchWorkspace(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="bare-button" title="Open project" onClick={openProject}>＋</button><button className="bare-button" title="Open workspace file (.code-workspace)" onClick={openWorkspaceFile}>🗂</button><button className="bare-button" title="Attach folder to this workspace" disabled={!active} onClick={attachRepo}>📎</button></div>
      {activeWorkspace?.kind === "multi" && !activeWorkspace.saved && <div className="workspace-unsaved"><span>Workspace not saved</span><button className="bare-button" onClick={saveWorkspaceAs}>Save As…</button></div>}
      <div className="section-heading"><span>SESSIONS</span><span>{activeWorkspace?.sessions.length ?? 0}</span></div>
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.kind === "multi" ? groupSessionsByRepo(activeWorkspace.repos, activeWorkspace.sessions).map(group => <div key={group.repoId} className="repo-group"><button className={`repo-header${active !== undefined && newSessionTargetFor(active) === group.repoId ? " active" : ""}`} title={`New sessions open in ${group.repoName}${group.repoPath ? ` (${group.repoPath})` : ""} — click to switch`} onClick={() => activeWorkspace && setActiveRepos(current => ({ ...current, [activeWorkspace.id]: group.repoId }))}><strong>{group.repoName}</strong><span className="repo-count">{group.sessions.length}</span></button>{activeWorkspace && group.sessions.map(session => renderSessionCard(activeWorkspace, session))}{group.sessions.length === 0 && <p className="no-sessions">No sessions yet.</p>}</div>) : activeWorkspace?.sessions.map(session => renderSessionCard(activeWorkspace, session))}{activeWorkspace && activeWorkspace.sessions.length === 0 && activeWorkspace.kind !== "multi" && <p className="no-sessions">Your first message will name this session.</p>}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Native chat<br /><small>One engine, one interaction model</small></div>
    </aside>}
    {!sidebarOpen && <button className="sidebar-reveal icon-button" onClick={() => setSidebarOpen(true)}>☰</button>}
    {sidebarOpen && <div className="resizer resizer-left" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize sidebar (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setSidebarWidth(value => clamp(value + (event.key === "ArrowLeft" ? -10 : 10), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)); }} onMouseDown={event => beginResize("left", event)} onDoubleClick={() => resetResize("left")} />}
    <section className="chat-main"><header className="titlebar"><div className="title-copy"><strong>{activeWorkspace?.sessions.find(session => session.id === activeSessions[activeWorkspace.id])?.firstMessage || "New session"}</strong><span><b>{activeWorkspace?.name ?? "No project"}</b><i /> Chat v{VERSION}</span></div><div className="title-actions">{backendExit !== undefined && <span className="backend-exit">Backend exited <button className="bare-button" onClick={retryLastChat}>Retry</button></span>}<ThemeMenu /><button className="icon-button" title="Toggle Git" onClick={() => setInspectorOpen(value => !value)}>◫</button></div></header><ChatPane workspaceId={active} repoId={chatRepoId} sessionId={activeSessionId} onSend={request => { lastChat.current = request; setBusyTurns(current => trackTurnStart(current, request.id, { workspaceId: request.workspaceId, sessionId: request.sessionId })); }} onRequestNewSession={workspaceId => { if (workspaceId) selectSession(workspaceId, undefined, newSessionTargetFor(workspaceId)); }} onAdoptSession={(workspaceId, repoId, sessionId) => {
        if (workspaceId === undefined) return;
        if (repoId !== undefined) setActiveRepos(current => (current[workspaceId] === repoId ? current : { ...current, [workspaceId]: repoId }));
        setActiveSessions(current => current[workspaceId] === undefined ? { ...current, [workspaceId]: sessionId } : current);
        setBusyTurns(current => migrateAdoptedSession(current, workspaceId, sessionId));
      }} /></section>
    {inspectorVisible && <div className="resizer resizer-right" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize git panel" title="Drag to resize git panel (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setInspectorWidth(value => clamp(value + (event.key === "ArrowLeft" ? 10 : -10), MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)); }} onMouseDown={event => beginResize("right", event)} onDoubleClick={() => resetResize("right")} />}
    {activeWorkspace && inspectorVisible && (activeWorkspace.kind === "multi" ? (
      <GitPanel title={activeWorkspace.name} onClose={() => setInspectorOpen(false)}>
        <div className="git-stack">{activeWorkspace.repos.map(repo => {
          if (repo.missing) return <section key={repo.id} className="git-repo"><div className="repo-header"><strong>{repo.name}</strong></div><p className="git-empty">Directory unavailable.</p></section>;
          const scope = repoScopeKey(activeWorkspace.id, repo.id);
          return <GitRepoCard key={repo.id} workspaceId={activeWorkspace.id} repoId={repo.id} repoName={repo.name} state={multiGit[scope]} collapsed={gitCollapsed[scope] === true} onToggleCollapsed={() => setGitCollapsed(current => ({ ...current, [scope]: !(current[scope] === true) }))} onRefresh={() => refreshMultiGit(activeWorkspace.id)} />;
        })}</div>
      </GitPanel>
    ) : (
      <GitPanel title={`${gitStates[activeWorkspace.id]?.branch ?? "Repository"}${gitStates[activeWorkspace.id] && (gitStates[activeWorkspace.id]?.ahead || gitStates[activeWorkspace.id]?.behind) ? ` ↑${gitStates[activeWorkspace.id]?.ahead} ↓${gitStates[activeWorkspace.id]?.behind}` : ""}`} onClose={() => setInspectorOpen(false)}>
        <GitRepoCard workspaceId={activeWorkspace.id} repoId={undefined} state={gitStates[activeWorkspace.id]} onRefresh={async () => {
          const git = await window.cloudcode.gitState(activeWorkspace.id);
          setGitStates(current => ({ ...current, [activeWorkspace.id]: git }));
        }} />
      </GitPanel>
    ))}
    <StatusBar
      status={status}
      gitBranch={activeWorkspace?.kind === "multi" && active !== undefined
        ? statusGitLabel(multiGit[repoScopeKey(active, chatRepoId)]?.branch, dirtyRepoCount(Object.fromEntries(activeWorkspace.repos.map(repo => [repo.id, multiGit[repoScopeKey(activeWorkspace.id, repo.id)]]))), activeWorkspace.repos.length)
        : active !== undefined ? gitStates[active]?.branch : undefined}
      gitDirty={activeWorkspace?.kind === "multi" && active !== undefined
        ? dirtyRepoCount(Object.fromEntries(activeWorkspace.repos.map(repo => [repo.id, multiGit[repoScopeKey(activeWorkspace.id, repo.id)]]))) > 0
        : active !== undefined ? (gitStates[active]?.files.length ?? 0) > 0 : undefined}
      onOpenPicker={() => setPickerOpen(true)}
    />
    {pickerOpen && <StatuslinePicker
      initial={status?.statusLineItems ?? []}
      onSave={items => {
        setPickerOpen(false);
        void window.cloudcode.chatStatusLineSet({ id: `statusline-${Date.now()}`, items, sessionId: activeSessionId, workspaceId: active, ...(chatRepoId === undefined ? {} : { repoId: chatRepoId }) }).catch(() => {});
      }}
      onClose={() => setPickerOpen(false)}
    />}
  </main>;
}

function formatSessionDate(timestamp: string): string { const value = new Date(timestamp); return Number.isNaN(value.getTime()) ? "Saved" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value); }

createRoot(document.getElementById("root")!).render(<App />);
