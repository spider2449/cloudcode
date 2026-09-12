const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cloudcode", {
  openProject: () => ipcRenderer.invoke("cloudcode:open-project"),
  restoreProjects: () => ipcRenderer.invoke("cloudcode:restore-projects"),
  refreshWorkspace: workspaceId => ipcRenderer.invoke("cloudcode:refresh-workspace", workspaceId),
  gitState: workspaceId => ipcRenderer.invoke("cloudcode:git-state", workspaceId),
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
  chatSend: (request) => ipcRenderer.invoke("cloudcode:chat-send", request),
  chatAbort: (id) => ipcRenderer.invoke("cloudcode:chat-abort", id),
  chatHistory: (sessionId, workspaceId) => ipcRenderer.invoke("cloudcode:chat-history", sessionId, workspaceId),
  chatRespond: (response) => ipcRenderer.invoke("cloudcode:chat-respond", response),
  chatComplete: (request) => ipcRenderer.invoke("cloudcode:chat-complete", request),
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
