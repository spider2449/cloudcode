import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { terminalKeySequence } from "./terminalKeys.js";
import { VERSION } from "../../src/version.js";

type Session = { id: string; firstMessage: string; timestamp: string; provider: string };
type Workspace = { id: string; name: string; sessions: Session[] };
type GitFile = { path: string; originalPath?: string; index: string; workingTree: string };
type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string };
type GitDiff = { text: string; truncated: boolean; error?: string };

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
      startTerminal(workspaceId: string, sessionId: string | undefined, columns: number, rows: number, generation: string): Promise<void>;
      writeTerminal(data: string): Promise<void>;
      resizeTerminal(columns: number, rows: number): Promise<void>;
      closeApplication(): Promise<void>;
      onTerminalData(listener: (payload: { generation: string; data: string }) => void): () => void;
      onTerminalExit(listener: (payload: { generation: string; exitCode: number }) => void): () => void;
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
  const [gitStates, setGitStates] = useState<Record<string, GitState | undefined>>({});
  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalExit, setTerminalExit] = useState<number>();
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth("cloudcode.sidebarWidth", DEFAULT_SIDEBAR_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readStoredWidth("cloudcode.inspectorWidth", DEFAULT_INSPECTOR_WIDTH));
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  const dragState = useRef<{ side: "left" | "right"; startX: number; startSidebar: number; startInspector: number } | null>(null);
  const terminalElement = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fitAddon = useRef<FitAddon>();
  const currentTerminalGeneration = useRef("");
  const activeWorkspace = workspaces.find(workspace => workspace.id === active);

  useEffect(() => {
    const element = terminalElement.current;
    if (!element) return;
    const instance = new Terminal({
      // The embedded TUI draws its own solid block marker at the input
      // position, so a blinking native cursor on the same cell renders as a
      // second, redundant indicator. Keep the native cursor solid instead.
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: { background: "#15171b", foreground: "#d8dbe1", cursor: "#dce5f5", selectionBackground: "#536d9970" }
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(element);
    instance.attachCustomKeyEventHandler(event => {
      const sequence = terminalKeySequence(event);
      if (sequence === undefined) return true;
      void window.cloudcode.writeTerminal(sequence);
      return false;
    });
    fit.fit();
    terminal.current = instance;
    fitAddon.current = fit;
    const input = instance.onData(data => { void window.cloudcode.writeTerminal(data); });
    const removeData = window.cloudcode.onTerminalData(payload => {
      if (payload.generation === currentTerminalGeneration.current) instance.write(payload.data);
    });
    const removeExit = window.cloudcode.onTerminalExit(({ generation, exitCode }) => {
      if (generation === currentTerminalGeneration.current) setTerminalExit(exitCode);
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      void window.cloudcode.resizeTerminal(instance.cols, instance.rows);
    });
    observer.observe(element);
    setTerminalReady(true);
    return () => {
      observer.disconnect();
      input.dispose();
      removeData();
      removeExit();
      instance.dispose();
      terminal.current = undefined;
      fitAddon.current = undefined;
    };
  }, []);

  useEffect(() => {
    void window.cloudcode.restoreProjects().then(restored => {
      setWorkspaces(restored);
      setActive(restored[0]?.id);
      setActiveSessions(Object.fromEntries(restored.map(workspace => [workspace.id, workspace.sessions[0]?.id])));
    });
  }, []);

  useEffect(() => {
    if (!active || !terminalReady) return;
    const sessionId = activeSessions[active];
    const instance = terminal.current;
    if (!instance) return;
    instance.clear();
    setTerminalExit(undefined);
    fitAddon.current?.fit();
    const generation = `${active}:${terminalGeneration}:${Date.now()}`;
    currentTerminalGeneration.current = generation;
    void window.cloudcode.startTerminal(active, sessionId, instance.cols, instance.rows, generation).catch(error => {
      if (currentTerminalGeneration.current === generation) instance.writeln(`\r\n${error instanceof Error ? error.message : String(error)}`);
    });
  }, [active, activeSessions, terminalReady, terminalGeneration]);

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
        if (!disposed) setGitStates(current => ({ ...current, [active]: { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false, error: error instanceof Error ? error.message : String(error) } }));
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
      fitAddon.current?.fit();
      const instance = terminal.current;
      if (instance) void window.cloudcode.resizeTerminal(instance.cols, instance.rows);
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
    requestAnimationFrame(() => {
      fitAddon.current?.fit();
      const instance = terminal.current;
      if (instance) void window.cloudcode.resizeTerminal(instance.cols, instance.rows);
    });
  }

  const inspectorVisible = inspectorOpen && activeWorkspace !== undefined;
  const gridTemplateColumns = !sidebarOpen && !inspectorVisible
    ? "minmax(0, 1fr)"
    : sidebarOpen && inspectorVisible
      ? `${sidebarWidth}px 5px minmax(0, 1fr) 5px ${inspectorWidth}px`
      : sidebarOpen
        ? `${sidebarWidth}px 5px minmax(0, 1fr)`
        : `minmax(0, 1fr) 5px ${inspectorWidth}px`;

  function switchWorkspace(nextId: string) {
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

  async function openProject() {
    const workspace = await window.cloudcode.openProject();
    if (!workspace) return;
    setWorkspaces(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
    setActiveSessions(current => ({ ...current, [workspace.id]: workspace.sessions[0]?.id }));
    setActive(workspace.id);
  }

  function selectSession(workspaceId: string, sessionId: string | undefined) {
    setActiveSessions(current => ({ ...current, [workspaceId]: sessionId }));
    setTerminalGeneration(value => value + 1);
  }

  return <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorVisible ? "" : "inspector-collapsed"}${dragging ? " resizing" : ""}`} style={{ gridTemplateColumns }}>
    {sidebarOpen && <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><span className="brand-mark">C</span><span>CloudCode</span><span className="brand-version">v{VERSION}</span></div><button className="icon-button" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button></div>
      <button className="new-session" disabled={!active} onClick={() => active && selectSession(active, undefined)}><span>＋</span> New session <kbd>Ctrl N</kbd></button>
      <div className="project-switcher"><span>⌘</span><select aria-label="Active project" value={active ?? ""} onChange={event => switchWorkspace(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="bare-button" title="Open project" onClick={openProject}>＋</button></div>
      <div className="section-heading"><span>SESSIONS</span><span>{activeWorkspace?.sessions.length ?? 0}</span></div>
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.sessions.map(session => <button key={session.id} className={activeSessions[activeWorkspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(activeWorkspace.id, session.id)}><span className="session-title">{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button>)}{activeWorkspace && activeWorkspace.sessions.length === 0 && <p className="no-sessions">Your first message will name this session.</p>}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Embedded CloudCode TUI<br /><small>One engine, one interaction model</small></div>
    </aside>}
    {!sidebarOpen && <button className="sidebar-reveal icon-button" onClick={() => setSidebarOpen(true)}>☰</button>}
    {sidebarOpen && <div className="resizer resizer-left" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize sidebar (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setSidebarWidth(value => clamp(value + (event.key === "ArrowLeft" ? -10 : 10), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)); }} onMouseDown={event => beginResize("left", event)} onDoubleClick={() => resetResize("left")} />}
    <section className="terminal-pane"><header className="titlebar"><div className="title-copy"><strong>{activeWorkspace?.sessions.find(session => session.id === activeSessions[activeWorkspace.id])?.firstMessage || "New session"}</strong><span><b>{activeWorkspace?.name ?? "No project"}</b><i /> TUI v{VERSION}</span></div><div className="title-actions">{terminalExit !== undefined && <span className="terminal-exit">Exited ({terminalExit})</span>}<button className="icon-button" title="Toggle Git" onClick={() => setInspectorOpen(value => !value)}>◫</button></div></header><div className="terminal-host" ref={terminalElement} /></section>
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

createRoot(document.getElementById("root")!).render(<App />);
