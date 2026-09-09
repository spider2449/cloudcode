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
  startTerminal: (workspaceId, sessionId, columns, rows, generation) => ipcRenderer.invoke("cloudcode:terminal-start", workspaceId, sessionId, columns, rows, generation),
  drainTerminal: generation => ipcRenderer.invoke("cloudcode:terminal-drain", generation),
  writeTerminal: data => ipcRenderer.invoke("cloudcode:terminal-write", data),
  terminalBusy: () => ipcRenderer.invoke("cloudcode:terminal-busy"),
  onTerminalBusy: listener => {
    const callback = (_event, payload) => listener(payload);
    ipcRenderer.on("cloudcode:terminal-busy", callback);
    return () => ipcRenderer.removeListener("cloudcode:terminal-busy", callback);
  },
  resizeTerminal: (columns, rows) => ipcRenderer.invoke("cloudcode:terminal-resize", columns, rows),
  closeApplication: () => ipcRenderer.invoke("cloudcode:close-application"),
  onTerminalExit: listener => {
    const callback = (_event, payload) => listener(payload);
    ipcRenderer.on("cloudcode:terminal-exit", callback);
    return () => ipcRenderer.removeListener("cloudcode:terminal-exit", callback);
  }
});
