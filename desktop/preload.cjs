const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cloudcode", {
  openProject: () => ipcRenderer.invoke("cloudcode:open-project"),
  openWorkspaceFile: () => ipcRenderer.invoke("cloudcode:open-workspace-file"),
  restoreProjects: () => ipcRenderer.invoke("cloudcode:restore-projects"),
  refreshWorkspace: workspaceId => ipcRenderer.invoke("cloudcode:refresh-workspace", workspaceId),
  gitState: workspaceId => ipcRenderer.invoke("cloudcode:git-state", workspaceId),
  gitStates: workspaceId => ipcRenderer.invoke("cloudcode:git-states", workspaceId),
  gitDiff: (workspaceId, path, staged) => ipcRenderer.invoke("cloudcode:git-diff", workspaceId, path, staged),
  gitStage: (workspaceId, paths) => ipcRenderer.invoke("cloudcode:git-stage", workspaceId, paths),
  gitStageAll: workspaceId => ipcRenderer.invoke("cloudcode:git-stage-all", workspaceId),
  gitUnstage: (workspaceId, paths) => ipcRenderer.invoke("cloudcode:git-unstage", workspaceId, paths),
  gitUnstageAll: workspaceId => ipcRenderer.invoke("cloudcode:git-unstage-all", workspaceId),
  gitCommit: (workspaceId, message) => ipcRenderer.invoke("cloudcode:git-commit", workspaceId, message),
  gitBranches: workspaceId => ipcRenderer.invoke("cloudcode:git-branches", workspaceId),
  gitCheckout: (workspaceId, branch) => ipcRenderer.invoke("cloudcode:git-checkout", workspaceId, branch),
  gitCreateBranch: (workspaceId, branch) => ipcRenderer.invoke("cloudcode:git-create-branch", workspaceId, branch),
  gitPush: (workspaceId, branch) => ipcRenderer.invoke("cloudcode:git-push", workspaceId, branch),
  gitPull: workspaceId => ipcRenderer.invoke("cloudcode:git-pull", workspaceId),
  gitFetch: workspaceId => ipcRenderer.invoke("cloudcode:git-fetch", workspaceId),
  // Multi-repo variants: same operations scoped to one repo of a workspace.
  // The single-repo entries above are untouched for backward compatibility.
  gitDiffIn: (workspaceId, repoId, path, staged) => ipcRenderer.invoke("cloudcode:git-diff-in", workspaceId, repoId, path, staged),
  gitStageIn: (workspaceId, repoId, paths) => ipcRenderer.invoke("cloudcode:git-stage-in", workspaceId, repoId, paths),
  gitStageAllIn: (workspaceId, repoId) => ipcRenderer.invoke("cloudcode:git-stage-all-in", workspaceId, repoId),
  gitUnstageIn: (workspaceId, repoId, paths) => ipcRenderer.invoke("cloudcode:git-unstage-in", workspaceId, repoId, paths),
  gitUnstageAllIn: (workspaceId, repoId) => ipcRenderer.invoke("cloudcode:git-unstage-all-in", workspaceId, repoId),
  gitCommitIn: (workspaceId, repoId, message) => ipcRenderer.invoke("cloudcode:git-commit-in", workspaceId, repoId, message),
  gitBranchesIn: (workspaceId, repoId) => ipcRenderer.invoke("cloudcode:git-branches-in", workspaceId, repoId),
  gitCheckoutIn: (workspaceId, repoId, branch) => ipcRenderer.invoke("cloudcode:git-checkout-in", workspaceId, repoId, branch),
  gitCreateBranchIn: (workspaceId, repoId, branch) => ipcRenderer.invoke("cloudcode:git-create-branch-in", workspaceId, repoId, branch),
  gitPushIn: (workspaceId, repoId, branch) => ipcRenderer.invoke("cloudcode:git-push-in", workspaceId, repoId, branch),
  gitPullIn: (workspaceId, repoId) => ipcRenderer.invoke("cloudcode:git-pull-in", workspaceId, repoId),
  gitFetchIn: (workspaceId, repoId) => ipcRenderer.invoke("cloudcode:git-fetch-in", workspaceId, repoId),
  chatSend: (request) => ipcRenderer.invoke("cloudcode:chat-send", request),
  chatAbort: (id) => ipcRenderer.invoke("cloudcode:chat-abort", id),
  chatHistory: (sessionId, workspaceId, repoId) => ipcRenderer.invoke("cloudcode:chat-history", sessionId, workspaceId, repoId),
  chatRespond: (response) => ipcRenderer.invoke("cloudcode:chat-respond", response),
  chatComplete: (request) => ipcRenderer.invoke("cloudcode:chat-complete", request),
  chatStatus: (request) => ipcRenderer.invoke("cloudcode:chat-status", request),
  chatStatusLineSet: (request) => ipcRenderer.invoke("cloudcode:chat-statusline-set", request),
  renameSession: (workspaceId, sessionId, title) => ipcRenderer.invoke("cloudcode:rename-session", workspaceId, sessionId, title),
  removeSession: (workspaceId, sessionId) => ipcRenderer.invoke("cloudcode:remove-session", workspaceId, sessionId),
  setTheme: name => ipcRenderer.invoke("cloudcode:set-theme", name),
  onChatEvent: listener => {
    const callback = (_event, payload) => listener(payload);
    ipcRenderer.on("cloudcode:chat-event", callback);
    return () => ipcRenderer.removeListener("cloudcode:chat-event", callback);
  },
  closeApplication: () => ipcRenderer.invoke("cloudcode:close-application")
});
