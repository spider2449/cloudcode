import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { terminalKeySequence } from "./terminalKeys.js";

type Session = { id: string; firstMessage: string; timestamp: string; provider: string };
type Workspace = { id: string; name: string; sessions: Session[] };
type GitState = { isGitRepo: boolean; branch?: string; files: Array<{ path: string; index: string; workingTree: string }>; error?: string };

declare global {
  interface Window {
    cloudcode: {
      openProject(): Promise<Workspace | undefined>;
      restoreProjects(): Promise<Workspace[]>;
      refreshWorkspace(workspaceId: string): Promise<Workspace>;
      gitState(workspaceId: string): Promise<GitState>;
      startTerminal(workspaceId: string, sessionId: string | undefined, columns: number, rows: number): Promise<void>;
      writeTerminal(data: string): Promise<void>;
      resizeTerminal(columns: number, rows: number): Promise<void>;
      closeApplication(): Promise<void>;
      onTerminalData(listener: (data: string) => void): () => void;
      onTerminalExit(listener: (payload: { exitCode: number }) => void): () => void;
    };
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
  const terminalElement = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fitAddon = useRef<FitAddon>();
  const activeWorkspace = workspaces.find(workspace => workspace.id === active);

  useEffect(() => {
    const element = terminalElement.current;
    if (!element) return;
    const instance = new Terminal({
      cursorBlink: true,
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
    const removeData = window.cloudcode.onTerminalData(data => instance.write(data));
    const removeExit = window.cloudcode.onTerminalExit(({ exitCode }) => setTerminalExit(exitCode));
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
    void window.cloudcode.startTerminal(active, sessionId, instance.cols, instance.rows);
  }, [active, activeSessions, terminalReady, terminalGeneration]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const refresh = () => {
      void Promise.all([window.cloudcode.refreshWorkspace(active), window.cloudcode.gitState(active)]).then(([workspace, git]) => {
        if (disposed) return;
        setWorkspaces(current => current.map(item => item.id === active ? workspace : item));
        setGitStates(current => ({ ...current, [active]: git }));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active]);

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

  return <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorOpen ? "" : "inspector-collapsed"}`}>
    <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><span className="brand-mark">C</span><span>CloudCode</span></div><button className="icon-button" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button></div>
      <button className="new-session" disabled={!active} onClick={() => active && selectSession(active, undefined)}><span>＋</span> New session <kbd>Ctrl N</kbd></button>
      <div className="project-switcher"><span>⌘</span><select aria-label="Active project" value={active ?? ""} onChange={event => setActive(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="bare-button" title="Open project" onClick={openProject}>＋</button></div>
      <div className="section-heading"><span>SESSIONS</span><span>{activeWorkspace?.sessions.length ?? 0}</span></div>
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.sessions.map(session => <button key={session.id} className={activeSessions[activeWorkspace.id] === session.id ? "session-card active" : "session-card"} onClick={() => selectSession(activeWorkspace.id, session.id)}><span className="session-title">{session.firstMessage || "Untitled session"}</span><span className="session-meta">{formatSessionDate(session.timestamp)} · {session.provider}</span></button>)}{activeWorkspace && activeWorkspace.sessions.length === 0 && <p className="no-sessions">Your first message will name this session.</p>}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Embedded CloudCode TUI<br /><small>One engine, one interaction model</small></div>
    </aside>
    {!sidebarOpen && <button className="sidebar-reveal icon-button" onClick={() => setSidebarOpen(true)}>☰</button>}
    <section className="terminal-pane"><header className="titlebar"><div className="title-copy"><strong>{activeWorkspace?.sessions.find(session => session.id === activeSessions[activeWorkspace.id])?.firstMessage || "New session"}</strong><span><b>{activeWorkspace?.name ?? "No project"}</b><i /> TUI</span></div><div className="title-actions">{terminalExit !== undefined && <span className="terminal-exit">Exited ({terminalExit})</span>}<button className="icon-button" title="Toggle Git" onClick={() => setInspectorOpen(value => !value)}>◫</button></div></header><div className="terminal-host" ref={terminalElement} /></section>
    {activeWorkspace && <GitInspector state={gitStates[activeWorkspace.id]} onClose={() => setInspectorOpen(false)} />}
  </main>;
}

function GitInspector({ state, onClose }: { state: GitState | undefined; onClose(): void }) {
  const staged = state?.files.filter(file => file.index !== " " && file.index !== "?") ?? [];
  const changes = state?.files.filter(file => file.workingTree !== " " || file.index === "?") ?? [];
  return <aside className="inspector"><div className="inspector-header"><div><span>GIT</span><strong>{state?.branch ?? "Repository"}</strong></div><button className="icon-button" onClick={onClose}>×</button></div>{!state ? <p className="git-empty">Reading repository status…</p> : !state.isGitRepo ? <p className="git-empty">{state.error ?? "Not a Git repository."}</p> : <><GitFileGroup title="STAGED CHANGES" files={staged} status="index" /><GitFileGroup title="CHANGES" files={changes} status="workingTree" />{state.files.length === 0 && <p className="git-empty"><span className="status-dot" />Working tree is clean.</p>}</>}</aside>;
}

function GitFileGroup({ title, files, status }: { title: string; files: GitState["files"]; status: "index" | "workingTree" }) {
  if (files.length === 0) return null;
  return <section className="git-group"><div className="section-heading"><span>{title}</span><span>{files.length}</span></div>{files.map((file, index) => <div className="git-file" key={`${file.path}-${index}`}><span className="git-badge">{gitStatusLabel(file[status])}</span><span title={file.path}>{file.path}</span></div>)}</section>;
}

function gitStatusLabel(status: string): string { return status === "?" || status === "A" ? "A" : status === "D" ? "D" : status === "R" ? "R" : status === "U" ? "U" : "M"; }
function formatSessionDate(timestamp: string): string { const value = new Date(timestamp); return Number.isNaN(value.getTime()) ? "Saved" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value); }

createRoot(document.getElementById("root")!).render(<App />);
