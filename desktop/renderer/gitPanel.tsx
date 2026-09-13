import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { GitDiff, GitFile, GitState } from "./bridge.js";

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

export function GitPanel({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <aside className="inspector"><div className="inspector-header"><div><span>GIT</span><strong>{title}</strong></div><button aria-label="Close Git panel" className="icon-button" onClick={onClose}>×</button></div>{children}</aside>;
}

export function GitRepoCard({ workspaceId, repoId, repoName, state, collapsed, onToggleCollapsed, onRefresh }: { workspaceId: string; repoId: string | undefined; repoName?: string; state: GitState | undefined; collapsed?: boolean; onToggleCollapsed?(): void; onRefresh(): Promise<void> }) {
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

export function gitStatusLabel(status: string): string { return status === "?" || status === "A" ? "A" : status === "D" ? "D" : status === "R" ? "R" : status === "U" ? "U" : "M"; }
export function gitFilePaths(file: GitFile): string[] { return file.originalPath ? [file.path, file.originalPath] : [file.path]; }
export function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "never fetched yet";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}
