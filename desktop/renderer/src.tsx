import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { VERSION } from "../../src/version.js";
import { ChatPane } from "./chatPane.js";
import { LAST_SELECTION_KEY, loadStoredSelection, resolveRestoredSelection, serializeSelection } from "./lastSelection.js";

type Session = { id: string; firstMessage: string; timestamp: string; provider: string };
type Workspace = { id: string; name: string; sessions: Session[] };
type GitFile = { path: string; originalPath?: string; index: string; workingTree: string };
type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string };
type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string; lastCommit?: GitCommit; recent: GitCommit[]; lastFetchedAt?: number };
type GitDiff = { text: string; truncated: boolean; error?: string };
type ChatRequest = { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined };
type ChatBridgeEvent = { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; sessionId?: unknown };

declare global {
  interface Window {
    cloudcode: {
      openProject(): Promise<Workspace | undefined>;
      restoreProjects(): Promise<Workspace[]>;
      refreshWorkspace(workspaceId: string): Promise<Workspace>;
      gitState(workspaceId: string): Promise<GitState>;
      gitDiff(workspaceId: string, path: string, staged: boolean): Promise<GitDiff>;
      gitStage(workspaceId: string, paths: string[]): Promise<void>;
      gitStageAll(workspaceId: string): Promise<void>;
      gitUnstage(workspaceId: string, paths: string[]): Promise<void>;
      gitUnstageAll(workspaceId: string): Promise<void>;
      gitCommit(workspaceId: string, message: string): Promise<void>;
      gitBranches(workspaceId: string): Promise<string[]>;
      gitCheckout(workspaceId: string, branch: string): Promise<void>;
      gitCreateBranch(workspaceId: string, branch: string): Promise<void>;
      gitPush(workspaceId: string, branch?: string): Promise<void>;
      gitPull(workspaceId: string): Promise<void>;
      gitFetch(workspaceId: string): Promise<void>;
      chatSend(request: ChatRequest): Promise<void>;
      chatAbort(id: string): Promise<void>;
      chatHistory(sessionId: string | undefined, workspaceId?: string): Promise<void>;
      chatRespond(response: { id: string; allow: boolean }): Promise<void>;
      chatComplete(request: { id: string; prefix: string; sessionId: string | undefined; workspaceId: string | undefined }): Promise<void>;
      renameSession(workspaceId: string, sessionId: string, title: string): Promise<Workspace>;
      removeSession(workspaceId: string, sessionId: string): Promise<Workspace>;
      onChatEvent(listener: (event: ChatBridgeEvent) => void): () => void;
      closeApplication(): Promise<void>;
    };
  }
}

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

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string>();
  const [activeSessions, setActiveSessions] = useState<Record<string, string | undefined>>({});
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [gitStates, setGitStates] = useState<Record<string, GitState | undefined>>({});
  const [backendExit, setBackendExit] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth("cloudcode.sidebarWidth", DEFAULT_SIDEBAR_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readStoredWidth("cloudcode.inspectorWidth", DEFAULT_INSPECTOR_WIDTH));
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  const dragState = useRef<{ side: "left" | "right"; startX: number; startSidebar: number; startInspector: number } | null>(null);
  const lastChat = useRef<ChatRequest | undefined>(undefined);
  // Set once the initial restore resolves; the persist effect below must not
  // run before that, or a slow restore would clobber the remembered value.
  const restoredRef = useRef(false);
  const activeWorkspace = workspaces.find(workspace => workspace.id === active);

  // Only the reserved backend id reports process exits; turn failures from
  // any other id render as error bubbles in the chat pane. A recovered
  // stream (text delta or turn completion) clears the banner again.
  useEffect(() => {
    return window.cloudcode.onChatEvent(event => {
      if (event.id === "backend" && event.type === "error") setBackendExit(event.text ?? "Backend exited");
      else if (event.type === "text_delta" || event.type === "done") setBackendExit(undefined);
    });
  }, []);

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
        const [workspace, git] = await Promise.all([window.cloudcode.refreshWorkspace(active), window.cloudcode.gitState(active)]);
        if (disposed) return;
        setWorkspaces(current => current.map(item => item.id === active ? workspace : item));
        setGitStates(current => ({ ...current, [active]: git }));
      } catch (error) {
        if (!disposed) setGitStates(current => ({ ...current, [active]: { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false, recent: [], error: error instanceof Error ? error.message : String(error) } }));
      } finally {
        if (!disposed) timer = window.setTimeout(refresh, document.hidden ? 10_000 : 3_000);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [active]);

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

  function switchWorkspace(nextId: string) {
    if (nextId === active) return;
    applyWorkspaceSwitch(nextId);
  }

  async function openProject() {
    const workspace = await window.cloudcode.openProject();
    if (!workspace) return;
    setWorkspaces(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
    setActiveSessions(current => ({ ...current, [workspace.id]: workspace.sessions[0]?.id }));
    setActive(workspace.id);
  }

  // Session switching no longer kills a live PTY, so no busy confirmation is needed.
  function selectSession(workspaceId: string, sessionId: string | undefined) {
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

  return <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorVisible ? "" : "inspector-collapsed"}${dragging ? " resizing" : ""}`} style={{ gridTemplateColumns }}>
    {sidebarOpen && <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><span className="brand-mark">C</span><span>CloudCode</span><span className="brand-version">v{VERSION}</span></div><button className="icon-button" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button></div>
      <button className="new-session" disabled={!active} onClick={() => active && selectSession(active, undefined)}><span>＋</span> New session <kbd>Ctrl N</kbd></button>
      <div className="project-switcher"><span>⌘</span><select aria-label="Active project" value={active ?? ""} onChange={event => switchWorkspace(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="bare-button" title="Open project" onClick={openProject}>＋</button></div>
      <div className="section-heading"><span>SESSIONS</span><span>{activeWorkspace?.sessions.length ?? 0}</span></div>
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.sessions.map(session => <div key={session.id} className="session-item">{editingId === session.id ? <input className="session-edit-input" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submitRename(activeWorkspace.id, session.id, draft); else if (event.key === "Escape") setEditingId(undefined); }} onBlur={() => void submitRename(activeWorkspace.id, session.id, draft)} aria-label="Rename session" /> : <><button className={activeSessions[activeWorkspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(activeWorkspace.id, session.id)}><span className="session-title">{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button><span className="session-actions"><button title="Rename session" aria-label={`Rename ${session.firstMessage || "Untitled session"}`} onClick={() => { setEditingId(session.id); setDraft(session.firstMessage); }}>✎</button><button title="Delete session" aria-label={`Delete ${session.firstMessage || "Untitled session"}`} onClick={() => void deleteSession(activeWorkspace.id, session.id)}>🗑</button></span></>}</div>)}{activeWorkspace && activeWorkspace.sessions.length === 0 && <p className="no-sessions">Your first message will name this session.</p>}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Native chat<br /><small>One engine, one interaction model</small></div>
    </aside>}
    {!sidebarOpen && <button className="sidebar-reveal icon-button" onClick={() => setSidebarOpen(true)}>☰</button>}
    {sidebarOpen && <div className="resizer resizer-left" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize sidebar (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setSidebarWidth(value => clamp(value + (event.key === "ArrowLeft" ? -10 : 10), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)); }} onMouseDown={event => beginResize("left", event)} onDoubleClick={() => resetResize("left")} />}
    <section className="chat-main"><header className="titlebar"><div className="title-copy"><strong>{activeWorkspace?.sessions.find(session => session.id === activeSessions[activeWorkspace.id])?.firstMessage || "New session"}</strong><span><b>{activeWorkspace?.name ?? "No project"}</b><i /> Chat v{VERSION}</span></div><div className="title-actions">{backendExit !== undefined && <span className="backend-exit">Backend exited <button className="bare-button" onClick={retryLastChat}>Retry</button></span>}<button className="icon-button" title="Toggle Git" onClick={() => setInspectorOpen(value => !value)}>◫</button></div></header><ChatPane workspaceId={active} sessionId={activeSessions[active ?? ""]} onSend={request => { lastChat.current = request; }} onRequestNewSession={workspaceId => { if (workspaceId) selectSession(workspaceId, undefined); }} onAdoptSession={(workspaceId, sessionId) => {
        if (workspaceId === undefined) return;
        setActiveSessions(current => current[workspaceId] === undefined ? { ...current, [workspaceId]: sessionId } : current);
      }} /></section>
    {inspectorVisible && <div className="resizer resizer-right" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize git panel" title="Drag to resize git panel (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setInspectorWidth(value => clamp(value + (event.key === "ArrowLeft" ? 10 : -10), MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)); }} onMouseDown={event => beginResize("right", event)} onDoubleClick={() => resetResize("right")} />}
    {activeWorkspace && inspectorVisible && <GitInspector workspaceId={activeWorkspace.id} state={gitStates[activeWorkspace.id]} onRefresh={async () => {
      const git = await window.cloudcode.gitState(activeWorkspace.id);
      setGitStates(current => ({ ...current, [activeWorkspace.id]: git }));
    }} onClose={() => setInspectorOpen(false)} />}
  </main>;
}

function GitInspector({ workspaceId, state, onRefresh, onClose }: { workspaceId: string; state: GitState | undefined; onRefresh(): Promise<void>; onClose(): void }) {
  const [selected, setSelected] = useState<{ file: GitFile; staged: boolean }>();
  const [diff, setDiff] = useState<GitDiff>();
  const [message, setMessage] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const staged = state?.files.filter(file => file.index !== " " && file.index !== "?") ?? [];
  const changes = state?.files.filter(file => file.workingTree !== " " || file.index === "?") ?? [];
  useEffect(() => { void window.cloudcode.gitBranches(workspaceId).then(setBranches).catch(() => setBranches([])); }, [workspaceId, state?.branch]);
  useEffect(() => {
    if (!selected) { setDiff(undefined); return; }
    let disposed = false;
    setDiff(undefined);
    void window.cloudcode.gitDiff(workspaceId, selected.file.path, selected.staged).then(value => { if (!disposed) setDiff(value); });
    return () => { disposed = true; };
  }, [workspaceId, selected]);
  async function mutate(operation: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await operation(); await onRefresh(); setSelected(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <aside className="inspector"><div className="inspector-header"><div><span>GIT</span><strong>{state?.branch ?? "Repository"}{state && (state.ahead || state.behind) ? ` ↑${state.ahead} ↓${state.behind}` : ""}</strong></div><button aria-label="Close Git panel" className="icon-button" onClick={onClose}>×</button></div>{!state ? <p className="git-empty">Reading repository status…</p> : !state.isGitRepo ? <p className="git-empty">{state.error ?? "Not a Git repository."}</p> : <>
    {state.truncated && <p className="git-error">Status is truncated; some files may be missing.</p>}
    <div className="git-branch"><select aria-label="Current branch" value={state.branch ?? ""} disabled={busy} onChange={event => void mutate(() => window.cloudcode.gitCheckout(workspaceId, event.target.value))}>{branches.map(branch => <option key={branch}>{branch}</option>)}</select><input aria-label="New branch" placeholder="New branch" value={newBranch} onChange={event => setNewBranch(event.target.value)} /><button disabled={busy || !newBranch.trim()} onClick={() => void mutate(async () => { await window.cloudcode.gitCreateBranch(workspaceId, newBranch.trim()); setNewBranch(""); })}>Create</button></div>
    <section className="git-sync"><div className="section-heading"><span>SYNC · {state.upstream ?? "untracked"}</span><button disabled={busy || !state.upstream} onClick={() => void mutate(() => window.cloudcode.gitFetch(workspaceId))}>Fetch</button></div><div className="git-sync-line"><span>↑{state.ahead} ahead · ↓{state.behind} behind · {formatRelativeTime(state.lastFetchedAt)}</span></div><div className="git-sync-actions"><button disabled={busy || (!state.upstream && !state.branch) || (state.ahead === 0 && !!state.upstream)} onClick={() => void mutate(() => state.upstream ? window.cloudcode.gitPush(workspaceId) : window.cloudcode.gitPush(workspaceId, state.branch))}>Push{state.ahead ? ` ↑${state.ahead}` : ""}</button><button disabled={busy || !state.upstream || state.behind === 0} onClick={() => void mutate(async () => { await window.cloudcode.gitFetch(workspaceId); await window.cloudcode.gitPull(workspaceId); })}>Pull{state.behind ? ` ↓${state.behind}` : ""}</button></div>{!state.upstream && <p className="git-hint">Untracked branch — Push sets upstream to origin/{state.branch}.</p>}</section>
    {state.lastCommit ? <section className="git-current"><div className="section-heading"><span>CURRENT</span></div><div className="git-commit-line" title={`${state.lastCommit.hash} · ${state.lastCommit.author} · ${state.lastCommit.date}`}><span className="git-hash">{state.lastCommit.shortHash}</span><span>{state.lastCommit.subject}</span></div><div className="git-meta">{state.lastCommit.author} · {state.lastCommit.date}</div></section> : <p className="git-empty">No commits yet.</p>}
    {state.recent.length > 1 && <section className="git-recent"><div className="section-heading"><span>RECENT · {state.recent.length}</span></div>{state.recent.slice(1).map(commit => <div className="git-commit-line" key={commit.hash} title={`${commit.hash} · ${commit.author} · ${commit.date}`}><span className="git-hash">{commit.shortHash}</span><span>{commit.subject}</span></div>)}</section>}
    <GitFileGroup title="STAGED CHANGES" files={staged} status="index" action="Unstage" disabled={busy} onSelect={file => setSelected({ file, staged: true })} onAction={file => void mutate(() => window.cloudcode.gitUnstage(workspaceId, gitFilePaths(file)))} onAll={() => void mutate(() => window.cloudcode.gitUnstageAll(workspaceId))} />
    <GitFileGroup title="CHANGES" files={changes} status="workingTree" action="Stage" disabled={busy} onSelect={file => setSelected({ file, staged: false })} onAction={file => void mutate(() => window.cloudcode.gitStage(workspaceId, gitFilePaths(file)))} onAll={() => void mutate(() => window.cloudcode.gitStageAll(workspaceId))} />
    {state.files.length === 0 && <p className="git-empty"><span className="status-dot" />Working tree is clean.</p>}
    {selected && <section className="git-diff"><div className="section-heading"><span>{selected.file.path}</span><button onClick={() => setSelected(undefined)}>Close</button></div>{!diff ? <p>Loading diff…</p> : diff.error ? <p className="git-error">{diff.error}</p> : <><pre>{diff.text || "No textual diff available."}</pre>{diff.truncated && <p className="git-error">Diff truncated.</p>}</>}</section>}
    <section className="git-commit"><textarea aria-label="Commit message" placeholder="Commit message" value={message} onChange={event => setMessage(event.target.value)} /><button disabled={busy || staged.length === 0 || !message.trim()} onClick={() => void mutate(async () => { await window.cloudcode.gitCommit(workspaceId, message.trim()); setMessage(""); })}>Commit {staged.length || ""}</button></section>
    {error && <p className="git-error">{error}</p>}
  </>}</aside>;
}

function GitFileGroup({ title, files, status, action, disabled, onSelect, onAction, onAll }: { title: string; files: GitState["files"]; status: "index" | "workingTree"; action: string; disabled: boolean; onSelect(file: GitFile): void; onAction(file: GitFile): void; onAll(): void }) {
  if (files.length === 0) return null;
  return <section className="git-group"><div className="section-heading"><span>{title} · {files.length}</span><button disabled={disabled} onClick={onAll}>{action} all</button></div>{files.map((file, index) => <div className="git-file" key={`${file.path}-${index}`}><button className="git-file-name" title={file.path} onClick={() => onSelect(file)}><span className="git-badge">{gitStatusLabel(file[status])}</span><span>{file.path}</span></button><button disabled={disabled} onClick={() => onAction(file)}>{action}</button></div>)}</section>;
}

function gitStatusLabel(status: string): string { return status === "?" || status === "A" ? "A" : status === "D" ? "D" : status === "R" ? "R" : status === "U" ? "U" : "M"; }
function gitFilePaths(file: GitFile): string[] { return file.originalPath ? [file.path, file.originalPath] : [file.path]; }
function formatSessionDate(timestamp: string): string { const value = new Date(timestamp); return Number.isNaN(value.getTime()) ? "Saved" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value); }
function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "never fetched yet";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

createRoot(document.getElementById("root")!).render(<App />);
