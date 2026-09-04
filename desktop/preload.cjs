const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cloudcode", {
  openProject: () => ipcRenderer.invoke("cloudcode:open-project"),
  restoreProjects: () => ipcRenderer.invoke("cloudcode:restore-projects"),
  refreshWorkspace: workspaceId => ipcRenderer.invoke("cloudcode:refresh-workspace", workspaceId),
  gitState: workspaceId => ipcRenderer.invoke("cloudcode:git-state", workspaceId),
  startTerminal: (workspaceId, sessionId, columns, rows) => ipcRenderer.invoke("cloudcode:terminal-start", workspaceId, sessionId, columns, rows),
  writeTerminal: data => ipcRenderer.invoke("cloudcode:terminal-write", data),
  resizeTerminal: (columns, rows) => ipcRenderer.invoke("cloudcode:terminal-resize", columns, rows),
  closeApplication: () => ipcRenderer.invoke("cloudcode:close-application"),
  onTerminalData: listener => {
    const callback = (_event, data) => listener(data);
    ipcRenderer.on("cloudcode:terminal-data", callback);
    return () => ipcRenderer.removeListener("cloudcode:terminal-data", callback);
  },
  onTerminalExit: listener => {
    const callback = (_event, payload) => listener(payload);
    ipcRenderer.on("cloudcode:terminal-exit", callback);
    return () => ipcRenderer.removeListener("cloudcode:terminal-exit", callback);
  }
});
