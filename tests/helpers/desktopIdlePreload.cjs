// Isolated renderer fixture: no real backend, projects, or user settings.
const listeners = new Set();
window.idleProbe = {
  requests: 0,
  emit(event) { for (const listener of listeners) listener(event); },
};
const status = { provider: "fixture", mode: "normal", cwd: "/fixture", costUsd: 0, statusLineItems: [] };
window.cloudcode = {
  restoreProjects: async () => [],
  onMenuAction: () => () => {},
  onChatEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  setNativeTheme: async () => {},
  chatHistory: async () => {
    setTimeout(() => window.idleProbe.emit({ id: "history-fixture", type: "assistant_text", text: "Selectable transcript text." }), 20);
  },
  chatStatus: async ({ id }) => {
    window.idleProbe.requests += 1;
    // Match the backend protocol, including query completion. A limit keeps
    // a regression from consuming the machine while the test is failing.
    if (window.idleProbe.requests > 100) throw new Error("Status feedback loop");
    setTimeout(() => {
      window.idleProbe.emit({ id, type: "status", status: { ...status } });
      window.idleProbe.emit({ id, type: "done" });
    }, 0);
  },
};
