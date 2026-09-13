// Shared bridge vocabulary between the shell (src.tsx) and the Git panel
// (gitPanel.tsx). Types only — no runtime, so nothing here can break the
// node-based unit tests or the Vite bundle.
export type Repo = { id: string; name: string; cwd: string; missing?: boolean };
export type Session = { id: string; firstMessage: string; timestamp: string; provider: string; repoId: string };
export type Workspace = { id: string; name: string; kind: "single" | "multi"; root: string; repos: Repo[]; sessions: Session[]; saved: boolean };
export type GitFile = { path: string; originalPath?: string; index: string; workingTree: string };
export type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string };
export type GitState = { isGitRepo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: GitFile[]; truncated: boolean; error?: string; lastCommit?: GitCommit; recent: GitCommit[]; lastFetchedAt?: number };
export type GitDiff = { text: string; truncated: boolean; error?: string };
export type ChatRequest = { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined; repoId: string | undefined };
export type ChatBridgeEvent = { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; sessionId?: unknown };

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
