import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
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

type Repo = { id: string; name: string; cwd: string; missing?: boolean };
type Session = { id: string; firstMessage: string; timestamp: string; provider: string; repoId: string };
type Workspace = { id: string; name: string; kind: "single" | "multi"; root: string; repos: Repo[]; sessions: Session[]; saved: boolean };
type GitFile = { path: string; originalPath?: string; index: string; workingTree: string };
type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string };
type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string; lastCommit?: GitCommit; recent: GitCommit[]; lastFetchedAt?: number };
type GitDiff = { text: string; truncated: boolean; error?: string };
type ChatRequest = { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined; repoId: string | undefined };
type ChatBridgeEvent = { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; sessionId?: unknown };

declare global {
  interface Window {
    cloudcode: {
      openProject(): Promise<Workspace | undefined>;
      openWorkspaceFile(): Promise<Workspace | undefined>;
      attachRepo(workspaceId: string): Promise<Workspace | undefined>;
      saveWorkspace(workspaceId: string, suggestedName: string): Promise<Workspace | undefined>;
      restoreProjects(): Promise<Workspace[]>;
      refreshWorkspace(workspaceId: string): Promise<Workspace>;
      gitState(workspaceId: string): Promise<GitState>;
      gitStates(workspaceId: string): Promise<Record<string, GitState>>;
      gitDiff(workspaceId: string, path: string, staged: boolean): Promise<GitDiff>;
      gitDiffIn(workspaceId: string, repoId: string, path: string, staged: boolean): Promise<GitDiff>;
      gitStage(workspaceId: string, paths: string[]): Promise<void>;
      gitStageIn(workspaceId: string, repoId: string, paths: string[]): Promise<void>;
      gitStageAll(workspaceId: string): Promise<void>;
      gitStageAllIn(workspaceId: string, repoId: string): Promise<void>;
      gitUnstage(workspaceId: string, paths: string[]): Promise<void>;
      gitUnstageIn(workspaceId: string, repoId: string, paths: string[]): Promise<void>;
      gitUnstageAll(workspaceId: string): Promise<void>;
      gitUnstageAllIn(workspaceId: string, repoId: string): Promise<void>;
      gitCommit(workspaceId: string, message: string): Promise<void>;
      gitCommitIn(workspaceId: string, repoId: string, message: string): Promise<void>;
      gitBranches(workspaceId: string): Promise<string[]>;
      gitBranchesIn(workspaceId: string, repoId: string): Promise<string[]>;
      gitCheckout(workspaceId: string, branch: string): Promise<void>;
      gitCheckoutIn(workspaceId: string, repoId: string, branch: string): Promise<void>;
      gitCreateBranch(workspaceId: string, branch: string): Promise<void>;
      gitCreateBranchIn(workspaceId: string, repoId: string, branch: string): Promise<void>;
      gitPush(workspaceId: string, branch?: string): Promise<void>;
      gitPushIn(workspaceId: string, repoId: string, branch?: string): Promise<void>;
      gitPull(workspaceId: string): Promise<void>;
      gitPullIn(workspaceId: string, repoId: string): Promise<void>;
      gitFetch(workspaceId: string): Promise<void>;
      gitFetchIn(workspaceId: string, repoId: string): Promise<void>;
      chatSend(request: ChatRequest): Promise<void>;
      chatAbort(id: string): Promise<void>;
      chatHistory(sessionId: string | undefined, workspaceId?: string, repoId?: string): Promise<void>;
      chatRespond(response: { id: string; allow: boolean }): Promise<void>;
      chatComplete(request: { id: string; prefix: string; sessionId: string | undefined; workspaceId: string | undefined; repoId?: string }): Promise<void>;
      chatStatus(request: { id: string; sessionId: string | undefined; workspaceId: string | undefined; repoId?: string }): Promise<void>;
      chatStatusLineSet(request: { id: string; items: string[]; sessionId: string | undefined; workspaceId: string | undefined; repoId?: string }): Promise<void>;
      renameSession(workspaceId: string, sessionId: string, title: string): Promise<Workspace>;
      removeSession(workspaceId: string, sessionId: string): Promise<Workspace>;
      onChatEvent(listener: (event: ChatBridgeEvent) => void): () => void;
      onMenuAction(listener: (payload: { action: string }) => void): () => void;
      setTheme(name: string): Promise<void>;
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

type GitBridge = {
  branches(): Promise<string[]>;
  diff(path: string, staged: boolean): Promise<GitDiff>;
  stage(paths: string[]): Promise<void>;
  stageAll(): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  unstageAll(): Promise<void>;
  commit(message: string): Promise<void>;
  checkout(branch: string): Promise<void>;
  createBranch(branch: string): Promise<void>;
  push(branch?: string): Promise<void>;
  pull(): Promise<void>;
  fetch(): Promise<void>;
};

// Dispatch Git mutations to the single-repo channels (repoId undefined,
// wire shape unchanged) or the multi-repo *-in channels.
function gitFor(workspaceId: string, repoId: string | undefined): GitBridge {
  const c = window.cloudcode;
  if (repoId === undefined) {
    return {
      branches: () => c.gitBranches(workspaceId),
      diff: (path, staged) => c.gitDiff(workspaceId, path, staged),
      stage: paths => c.gitStage(workspaceId, paths),
      stageAll: () => c.gitStageAll(workspaceId),
      unstage: paths => c.gitUnstage(workspaceId, paths),
      unstageAll: () => c.gitUnstageAll(workspaceId),
      commit: message => c.gitCommit(workspaceId, message),
      checkout: branch => c.gitCheckout(workspaceId, branch),
      createBranch: branch => c.gitCreateBranch(workspaceId, branch),
      push: branch => c.gitPush(workspaceId, branch),
      pull: () => c.gitPull(workspaceId),
      fetch: () => c.gitFetch(workspaceId),
    };
  }
  return {
    branches: () => c.gitBranchesIn(workspaceId, repoId),
    diff: (path, staged) => c.gitDiffIn(workspaceId, repoId, path, staged),
    stage: paths => c.gitStageIn(workspaceId, repoId, paths),
    stageAll: () => c.gitStageAllIn(workspaceId, repoId),
    unstage: paths => c.gitUnstageIn(workspaceId, repoId, paths),
    unstageAll: () => c.gitUnstageAllIn(workspaceId, repoId),
    commit: message => c.gitCommitIn(workspaceId, repoId, message),
    checkout: branch => c.gitCheckoutIn(workspaceId, repoId, branch),
    createBranch: branch => c.gitCreateBranchIn(workspaceId, repoId, branch),
    push: branch => c.gitPushIn(workspaceId, repoId, branch),
    pull: () => c.gitPullIn(workspaceId, repoId),
    fetch: () => c.gitFetchIn(workspaceId, repoId),
  };
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
  const [activeRepos, setActiveRepos] = useState<Record<string, string | undefined>>(() => loadStringRecord("cloudcode.activeRepos"));
  // Explicit target repo for the next New session (multi only, ephemeral).
  // The visible select makes the choice sticky per workspace; it never
  // affects the currently open session's repo scoping.
  const [newSessionRepo, setNewSessionRepo] = useState<Record<string, string | undefined>>({});
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
  // New sessions default to the effective repo but the picker below can
  // override per workspace (sticky until changed again). A stored override
  // pointing at a repo that no longer exists falls back to the effective repo.
  const storedTarget = active !== undefined ? newSessionRepo[active] : undefined;
  const newSessionTarget = activeWorkspace?.kind !== "multi" ? undefined : (
    activeWorkspace.repos.some(repo => repo.id === storedTarget) ? storedTarget : chatRepoId
  );
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
      <div className="new-session-row"><button className="new-session" disabled={!active} onClick={() => active && selectSession(active, undefined, newSessionTarget)}><span>＋</span> New session <kbd>Ctrl N</kbd></button>{activeWorkspace?.kind === "multi" && <select className="new-session-repo" aria-label="New session repo" title="Which repo the next new session opens in" value={newSessionTarget ?? ""} onChange={event => active && setNewSessionRepo(current => ({ ...current, [active]: event.target.value || undefined }))}>{activeWorkspace.repos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select>}</div>
      <div className="project-switcher"><span>⌘</span><select aria-label="Active project" value={active ?? ""} onChange={event => switchWorkspace(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="bare-button" title="Open project" onClick={openProject}>＋</button><button className="bare-button" title="Open workspace file (.code-workspace)" onClick={openWorkspaceFile}>🗂</button><button className="bare-button" title="Attach folder to this workspace" disabled={!active} onClick={attachRepo}>📎</button></div>
      {activeWorkspace?.kind === "multi" && !activeWorkspace.saved && <div className="workspace-unsaved"><span>Workspace not saved</span><button className="bare-button" onClick={saveWorkspaceAs}>Save As…</button></div>}
      <div className="section-heading"><span>SESSIONS</span><span>{activeWorkspace?.sessions.length ?? 0}</span></div>
      <nav className="workspace-list" aria-label="Sessions">{activeWorkspace?.kind === "multi" ? groupSessionsByRepo(activeWorkspace.repos, activeWorkspace.sessions).map(group => <div key={group.repoId} className="repo-group"><div className="repo-header" title={group.repoPath ?? group.repoName}><strong>{group.repoName}</strong><span className="repo-count">{group.sessions.length}</span></div>{activeWorkspace && group.sessions.map(session => renderSessionCard(activeWorkspace, session))}{group.sessions.length === 0 && <p className="no-sessions">No sessions yet.</p>}</div>) : activeWorkspace?.sessions.map(session => renderSessionCard(activeWorkspace, session))}{activeWorkspace && activeWorkspace.sessions.length === 0 && activeWorkspace.kind !== "multi" && <p className="no-sessions">Your first message will name this session.</p>}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Native chat<br /><small>One engine, one interaction model</small></div>
    </aside>}
    {!sidebarOpen && <button className="sidebar-reveal icon-button" onClick={() => setSidebarOpen(true)}>☰</button>}
    {sidebarOpen && <div className="resizer resizer-left" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize sidebar (double-click to reset)" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setSidebarWidth(value => clamp(value + (event.key === "ArrowLeft" ? -10 : 10), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)); }} onMouseDown={event => beginResize("left", event)} onDoubleClick={() => resetResize("left")} />}
    <section className="chat-main"><header className="titlebar"><div className="title-copy"><strong>{activeWorkspace?.sessions.find(session => session.id === activeSessions[activeWorkspace.id])?.firstMessage || "New session"}</strong><span><b>{activeWorkspace?.name ?? "No project"}</b><i /> Chat v{VERSION}</span></div><div className="title-actions">{backendExit !== undefined && <span className="backend-exit">Backend exited <button className="bare-button" onClick={retryLastChat}>Retry</button></span>}<ThemeMenu /><button className="icon-button" title="Toggle Git" onClick={() => setInspectorOpen(value => !value)}>◫</button></div></header><ChatPane workspaceId={active} repoId={chatRepoId} sessionId={activeSessionId} onSend={request => { lastChat.current = request; setBusyTurns(current => trackTurnStart(current, request.id, { workspaceId: request.workspaceId, sessionId: request.sessionId })); }} onRequestNewSession={workspaceId => { if (workspaceId) selectSession(workspaceId, undefined, workspaceId === active ? newSessionTarget : undefined); }} onAdoptSession={(workspaceId, repoId, sessionId) => {
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

function GitPanel({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <aside className="inspector"><div className="inspector-header"><div><span>GIT</span><strong>{title}</strong></div><button aria-label="Close Git panel" className="icon-button" onClick={onClose}>×</button></div>{children}</aside>;
}

function GitRepoCard({ workspaceId, repoId, repoName, state, collapsed, onToggleCollapsed, onRefresh }: { workspaceId: string; repoId: string | undefined; repoName?: string; state: GitState | undefined; collapsed?: boolean; onToggleCollapsed?(): void; onRefresh(): Promise<void> }) {
  const git = useMemo(() => gitFor(workspaceId, repoId), [workspaceId, repoId]);
  const [selected, setSelected] = useState<{ file: GitFile; staged: boolean }>();
  const [diff, setDiff] = useState<GitDiff>();
  const [message, setMessage] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const staged = state?.files.filter(file => file.index !== " " && file.index !== "?") ?? [];
  const changes = state?.files.filter(file => file.workingTree !== " " || file.index === "?") ?? [];
  useEffect(() => { void git.branches().then(setBranches).catch(() => setBranches([])); }, [git, state?.branch]);
  useEffect(() => {
    if (!selected) { setDiff(undefined); return; }
    let disposed = false;
    setDiff(undefined);
    void git.diff(selected.file.path, selected.staged).then(value => { if (!disposed) setDiff(value); });
    return () => { disposed = true; };
  }, [git, selected]);
  async function mutate(operation: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await operation(); await onRefresh(); setSelected(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const header = repoName === undefined ? null : <div className="repo-header"><button className="bare-button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${repoName}`} onClick={onToggleCollapsed}>{collapsed ? "▸" : "▾"}</button><strong>{repoName}</strong><span>{state?.branch ?? ""}{state && (state.ahead || state.behind) ? ` ↑${state.ahead} ↓${state.behind}` : ""}</span>{(state?.files.length ?? 0) > 0 && <span className="dirty-dot" title="Uncommitted changes" />}</div>;
  if (collapsed === true) return <section className="git-repo">{header}</section>;
  return <section className="git-repo">{header}{!state ? <p className="git-empty">Reading repository status…</p> : !state.isGitRepo ? <p className="git-empty">{state.error ?? "Not a Git repository."}</p> : <>
    {state.truncated && <p className="git-error">Status is truncated; some files may be missing.</p>}
    <div className="git-branch"><select aria-label="Current branch" value={state.branch ?? ""} disabled={busy} onChange={event => void mutate(() => git.checkout(event.target.value))}>{branches.map(branch => <option key={branch}>{branch}</option>)}</select><input aria-label="New branch" placeholder="New branch" value={newBranch} onChange={event => setNewBranch(event.target.value)} /><button disabled={busy || !newBranch.trim()} onClick={() => void mutate(async () => { await git.createBranch(newBranch.trim()); setNewBranch(""); })}>Create</button></div>
    <section className="git-sync"><div className="section-heading"><span>SYNC · {state.upstream ?? "untracked"}</span><button disabled={busy || !state.upstream} onClick={() => void mutate(() => git.fetch())}>Fetch</button></div><div className="git-sync-line"><span>↑{state.ahead} ahead · ↓{state.behind} behind · {formatRelativeTime(state.lastFetchedAt)}</span></div><div className="git-sync-actions"><button disabled={busy || (!state.upstream && !state.branch) || (state.ahead === 0 && !!state.upstream)} onClick={() => void mutate(() => state.upstream ? git.push() : git.push(state.branch))}>Push{state.ahead ? ` ↑${state.ahead}` : ""}</button><button disabled={busy || !state.upstream || state.behind === 0} onClick={() => void mutate(async () => { await git.fetch(); await git.pull(); })}>Pull{state.behind ? ` ↓${state.behind}` : ""}</button></div>{!state.upstream && <p className="git-hint">Untracked branch — Push sets upstream to origin/{state.branch}.</p>}</section>
    {state.lastCommit ? <section className="git-current"><div className="section-heading"><span>CURRENT</span></div><div className="git-commit-line" title={`${state.lastCommit.hash} · ${state.lastCommit.author} · ${state.lastCommit.date}`}><span className="git-hash">{state.lastCommit.shortHash}</span><span>{state.lastCommit.subject}</span></div><div className="git-meta">{state.lastCommit.author} · {state.lastCommit.date}</div></section> : <p className="git-empty">No commits yet.</p>}
    {state.recent.length > 1 && <section className="git-recent"><div className="section-heading"><span>RECENT · {state.recent.length}</span></div>{state.recent.slice(1).map(commit => <div className="git-commit-line" key={commit.hash} title={`${commit.hash} · ${commit.author} · ${commit.date}`}><span className="git-hash">{commit.shortHash}</span><span>{commit.subject}</span></div>)}</section>}
    <GitFileGroup title="STAGED CHANGES" files={staged} status="index" action="Unstage" disabled={busy} onSelect={file => setSelected({ file, staged: true })} onAction={file => void mutate(() => git.unstage(gitFilePaths(file)))} onAll={() => void mutate(() => git.unstageAll())} />
    <GitFileGroup title="CHANGES" files={changes} status="workingTree" action="Stage" disabled={busy} onSelect={file => setSelected({ file, staged: false })} onAction={file => void mutate(() => git.stage(gitFilePaths(file)))} onAll={() => void mutate(() => git.stageAll())} />
    {state.files.length === 0 && <p className="git-empty"><span className="status-dot" />Working tree is clean.</p>}
    {selected && <section className="git-diff"><div className="section-heading"><span>{selected.file.path}</span><button onClick={() => setSelected(undefined)}>Close</button></div>{!diff ? <p>Loading diff…</p> : diff.error ? <p className="git-error">{diff.error}</p> : <><pre>{diff.text || "No textual diff available."}</pre>{diff.truncated && <p className="git-error">Diff truncated.</p>}</>}</section>}
    <section className="git-commit"><textarea aria-label="Commit message" placeholder="Commit message" value={message} onChange={event => setMessage(event.target.value)} /><button disabled={busy || staged.length === 0 || !message.trim()} onClick={() => void mutate(async () => { await git.commit(message.trim()); setMessage(""); })}>Commit {staged.length || ""}</button></section>
    {error && <p className="git-error">{error}</p>}
  </>}</section>;
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
