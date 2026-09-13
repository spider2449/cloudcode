import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DesktopShellHost } from "../../../dist/desktop/shellHost.js";
import { requireBranchName, requirePaths, requireString } from "../../../dist/desktop/ipcContract.js";
import { resolveNodeExecutable } from "../../../dist/desktop/runtime.js";
import { VERSION } from "../../../dist/version.js";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: src/desktop/shell/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is three levels above src/desktop/shell/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..", "..", "..");
const host = new DesktopShellHost();
let window;
let chatChild;
// Set on before-quit so late renderer polls (e.g. the statusline footer)
// never respawn the backend or write to a dying pipe during shutdown.
let quitting = false;

function send(channel, payload) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

// A single shared backend serves all chat IPC. The child speaks
// newline-delimited JSON on stdout and each line becomes a renderer event.
function startChatBackend() {
  stopChatBackend();
  const cliPath = resolveCliPath();
  const executable = resolveNodeExecutable();
  chatChild = spawn(executable, [cliPath, "--gui-server"], { cwd: projectRoot, stdio: ["pipe", "pipe", "inherit"] });
  // Writes to a dead child's stdin surface as async EPIPE 'error' events,
  // which Electron shows as an "Uncaught Exception" dialog (seen on app
  // close when a status poll races the backend teardown). Swallow them and
  // drop the reference so the next write restarts the backend instead.
  chatChild.stdin.on("error", () => { stopChatBackend(); });
  chatChild.on("error", () => { stopChatBackend(); });
  let buffer = "";
  chatChild.stdout.setEncoding("utf8");
  chatChild.stdout.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.lastIndexOf("\n");
    if (newline === -1) return;
    const complete = buffer.slice(0, newline).split("\n");
    buffer = buffer.slice(newline + 1);
    for (const line of complete) {
      if (!line) continue;
      try { send("cloudcode:chat-event", JSON.parse(line)); } catch { /* malformed child output is ignored */ }
    }
  });
  chatChild.on("exit", () => {
    chatChild = undefined;
    // Reserved backend id: the renderer shows the exit banner only for this id.
    send("cloudcode:chat-event", { id: "backend", type: "error", text: "Chat backend exited." });
  });
}

function stopChatBackend() {
  if (!chatChild) return;
  const active = chatChild;
  chatChild = undefined;
  try { active.kill(); } catch { /* already exited */ }
}

// Writes to the backend never throw into Electron: a broken pipe means the
// child died mid-write (its exit handler may not have run yet), so restart it
// and tell the renderer the request was lost instead of crashing the app.
// During shutdown writes are dropped outright: respawning here is what kept
// the process alive long enough to hit the EPIPE dialog on close.
function writeChatBackend(line) {
  if (quitting) return false;
  try {
    if (!chatChild) startChatBackend();
    if (!chatChild) return false;
    chatChild.stdin.write(`${line}\n`);
    return true;
  } catch {
    stopChatBackend();
    if (!quitting) startChatBackend();
    return false;
  }
}

function backendLost(id) {
  send("cloudcode:chat-event", { id, type: "error", text: "Chat backend restarted; please resend." });
  send("cloudcode:chat-event", { id, type: "done" });
}

function forwardChatLine(line, id) {
  if (!writeChatBackend(line)) backendLost(id);
}

function resolveCliPath() {
  // Packaged layout: electron-builder packs files into app.asar, which the
  // Electron process can read but the child node.exe spawned below cannot.
  // package.json declares dist/ under asarUnpack, so the CLI lives on disk at
  // resources/app.asar.unpacked/dist/cli.js. Dev layout: repo/dist/cli.js.
  const candidates = [];
  if (process.resourcesPath && desktopDir.includes(".asar")) {
    candidates.push(join(process.resourcesPath, "app.asar.unpacked", "dist", "cli.js"));
    candidates.push(join(process.resourcesPath, "app", "dist", "cli.js"));
  }
  candidates.push(join(desktopDir, "..", "..", "..", "dist", "cli.js"));
  candidates.push(join(projectRoot, "dist", "cli.js"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot find dist/cli.js. Checked: ${candidates.join(", ")}`);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 880, minWidth: 900, minHeight: 600, backgroundColor: "#101216",
    title: `CloudCode v${VERSION}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(desktopDir, "preload.cjs") }
  });
  // Custom menu: the only addition over Electron's default is File > Save
  // Workspace As... The main process cannot know the active workspace, so the
  // click notifies the renderer, which runs its own save flow and no-ops
  // unless an unsaved multi workspace is active. Standard roles preserve the
  // copy/paste and window behavior of the default menu.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Save Workspace As…", accelerator: "CmdOrCtrl+S", click: () => send("cloudcode:menu-action", { action: "save-workspace" }) },
      { type: "separator" },
      { role: "quit" }
    ]},
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ]));
  const devServer = process.env.CLOUDCODE_DESKTOP_DEV_SERVER;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(desktopDir, "..", "..", "..", "dist", "renderer", "index.html"));
}

ipcMain.handle("cloudcode:open-project", async () => {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return host.openProject(result.filePaths[0]);
});
ipcMain.handle("cloudcode:open-workspace-file", async () => {
  // Separate file-only dialog: on Windows/Linux one dialog cannot be both a
  // file and a directory selector (a directory selector is shown instead),
  // so workspace files get their own picker with a .code-workspace filter.
  const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Workspace", extensions: ["code-workspace"] }] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return host.openProject(result.filePaths[0]);
});
ipcMain.handle("cloudcode:restore-projects", () => host.restoreProjects());
ipcMain.handle("cloudcode:attach-repo", async (_event, workspaceId) => {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return host.attachRepo(requireString(workspaceId, "workspace ID"), result.filePaths[0]);
});
ipcMain.handle("cloudcode:save-workspace", async (_event, workspaceId, suggestedName) => {
  const name = typeof suggestedName === "string" && suggestedName !== "" ? suggestedName : "workspace";
  const result = await dialog.showSaveDialog(window, {
    defaultPath: `${name}.code-workspace`,
    filters: [{ name: "Workspace", extensions: ["code-workspace"] }]
  });
  if (result.canceled || !result.filePath) return undefined;
  return host.saveWorkspaceAs(requireString(workspaceId, "workspace ID"), result.filePath);
});
ipcMain.handle("cloudcode:refresh-workspace", (_event, workspaceId) => host.refresh(requireString(workspaceId, "workspace ID")));
ipcMain.handle("cloudcode:git-state", (_event, workspaceId) => host.gitState(requireString(workspaceId, "workspace ID")));
ipcMain.handle("cloudcode:git-diff", (_event, workspaceId, path, staged) => host.gitService().diff(host.cwd(requireString(workspaceId, "workspace ID")), requireString(path, "Git path"), staged === true));
ipcMain.handle("cloudcode:git-stage", async (_event, workspaceId, paths) => host.gitService().stage(host.cwd(requireString(workspaceId, "workspace ID")), requirePaths(paths)));
ipcMain.handle("cloudcode:git-stage-all", async (_event, workspaceId) => host.gitService().stageAll(host.cwd(requireString(workspaceId, "workspace ID"))));
ipcMain.handle("cloudcode:git-unstage", async (_event, workspaceId, paths) => host.gitService().unstage(host.cwd(requireString(workspaceId, "workspace ID")), requirePaths(paths)));
ipcMain.handle("cloudcode:git-unstage-all", async (_event, workspaceId) => host.gitService().unstageAll(host.cwd(requireString(workspaceId, "workspace ID"))));
ipcMain.handle("cloudcode:git-commit", async (_event, workspaceId, message) => host.gitService().commit(host.cwd(requireString(workspaceId, "workspace ID")), requireString(message, "commit message").trim()));
ipcMain.handle("cloudcode:git-branches", (_event, workspaceId) => host.gitService().branches(host.cwd(requireString(workspaceId, "workspace ID"))));
ipcMain.handle("cloudcode:git-checkout", async (_event, workspaceId, branch) => host.gitService().checkout(host.cwd(requireString(workspaceId, "workspace ID")), requireBranchName(branch)));
ipcMain.handle("cloudcode:git-create-branch", async (_event, workspaceId, branch) => host.gitService().createBranch(host.cwd(requireString(workspaceId, "workspace ID")), requireBranchName(branch)));
ipcMain.handle("cloudcode:git-push", async (_event, workspaceId, branch) => host.gitPush(requireString(workspaceId, "workspace ID"), branch === undefined ? undefined : requireBranchName(branch)));
ipcMain.handle("cloudcode:git-pull", async (_event, workspaceId) => host.gitPull(requireString(workspaceId, "workspace ID")));
ipcMain.handle("cloudcode:git-fetch", async (_event, workspaceId) => host.gitFetch(requireString(workspaceId, "workspace ID")));
// Multi-repo workspace surface: same operations scoped to one repo via
// (workspaceId, repoId). The single-repo channels above are untouched so old
// callers keep working byte-for-byte.
function repoCwdOf(workspaceId, repoId) {
  const wid = requireString(workspaceId, "workspace ID");
  return repoId === undefined ? host.cwd(wid) : host.repoCwd(wid, requireString(repoId, "repo ID"));
}
ipcMain.handle("cloudcode:git-states", (_event, workspaceId) => host.gitStates(requireString(workspaceId, "workspace ID")));
ipcMain.handle("cloudcode:git-diff-in", (_event, workspaceId, repoId, path, staged) => host.gitService().diff(repoCwdOf(workspaceId, repoId), requireString(path, "Git path"), staged === true));
ipcMain.handle("cloudcode:git-stage-in", async (_event, workspaceId, repoId, paths) => host.gitService().stage(repoCwdOf(workspaceId, repoId), requirePaths(paths)));
ipcMain.handle("cloudcode:git-stage-all-in", async (_event, workspaceId, repoId) => host.gitService().stageAll(repoCwdOf(workspaceId, repoId)));
ipcMain.handle("cloudcode:git-unstage-in", async (_event, workspaceId, repoId, paths) => host.gitService().unstage(repoCwdOf(workspaceId, repoId), requirePaths(paths)));
ipcMain.handle("cloudcode:git-unstage-all-in", async (_event, workspaceId, repoId) => host.gitService().unstageAll(repoCwdOf(workspaceId, repoId)));
ipcMain.handle("cloudcode:git-commit-in", async (_event, workspaceId, repoId, message) => host.gitService().commit(repoCwdOf(workspaceId, repoId), requireString(message, "commit message").trim()));
ipcMain.handle("cloudcode:git-branches-in", (_event, workspaceId, repoId) => host.gitService().branches(repoCwdOf(workspaceId, repoId)));
ipcMain.handle("cloudcode:git-checkout-in", async (_event, workspaceId, repoId, branch) => host.gitService().checkout(repoCwdOf(workspaceId, repoId), requireBranchName(branch)));
ipcMain.handle("cloudcode:git-create-branch-in", async (_event, workspaceId, repoId, branch) => host.gitService().createBranch(repoCwdOf(workspaceId, repoId), requireBranchName(branch)));
ipcMain.handle("cloudcode:git-push-in", async (_event, workspaceId, repoId, branch) => host.gitService().push(repoCwdOf(workspaceId, repoId), branch === undefined ? undefined : requireBranchName(branch)));
ipcMain.handle("cloudcode:git-pull-in", async (_event, workspaceId, repoId) => host.gitService().pull(repoCwdOf(workspaceId, repoId)));
ipcMain.handle("cloudcode:git-fetch-in", async (_event, workspaceId, repoId) => host.gitService().fetch(repoCwdOf(workspaceId, repoId)));
ipcMain.handle("cloudcode:chat-send", (_event, request) => {
  if (typeof request !== "object" || request === null) {
    send("cloudcode:chat-event", { id: "unknown", type: "error", text: "Invalid chat request." });
    send("cloudcode:chat-event", { id: "unknown", type: "done" });
    return;
  }
  const { workspaceId, repoId, ...rest } = request;
  // Resolve the workspace to its filesystem root so turns and slash commands
  // run in the project the user is looking at, not the backend's own cwd.
  // Multi-repo workspaces pass repoId to target one repo instead of the first.
  let cwd;
  try {
    cwd = workspaceId === undefined ? undefined : repoCwdOf(workspaceId, repoId);
  } catch (error) {
    const id = typeof rest.id === "string" ? rest.id : "unknown";
    send("cloudcode:chat-event", { id, type: "error", text: error instanceof Error ? error.message : String(error) });
    send("cloudcode:chat-event", { id, type: "done" });
    return;
  }
  forwardChatLine(JSON.stringify(cwd === undefined ? rest : { ...rest, cwd }), typeof rest.id === "string" ? rest.id : "unknown");
});
ipcMain.handle("cloudcode:chat-abort", (_event, id) => {
  forwardChatLine(JSON.stringify({ kind: "abort", id }), typeof id === "string" ? id : "unknown");
});
ipcMain.handle("cloudcode:chat-history", (_event, sessionId, workspaceId, repoId) => {
  // Same workspace-to-directory resolution as chat-send: the backend resets
  // the workspace's live anonymous session on history(undefined), so the
  // New Session button starts genuinely fresh without touching other projects.
  // Multi-repo workspaces pass repoId to target one repo instead of the first.
  let cwd;
  try {
    cwd = workspaceId === undefined ? undefined : repoCwdOf(workspaceId, repoId);
  } catch {
    cwd = undefined;
  }
  forwardChatLine(JSON.stringify(cwd === undefined ? { kind: "history", sessionId } : { kind: "history", sessionId, cwd }), "history");
});
ipcMain.handle("cloudcode:chat-respond", (_event, response) => {
  const id = response !== null && typeof response === "object" && typeof response.id === "string" ? response.id : "unknown";
  forwardChatLine(JSON.stringify({ kind: "respond", ...response }), id);
});
ipcMain.handle("cloudcode:chat-complete", (_event, request) => {
  if (typeof request !== "object" || request === null) return;
  const { workspaceId, repoId, ...rest } = request;
  // Same workspace-to-directory resolution as chat-send so argument values
  // complete against the project the user is looking at.
  let cwd;
  try {
    cwd = workspaceId === undefined ? undefined : repoCwdOf(workspaceId, repoId);
  } catch {
    return;
  }
  const id = typeof rest.id === "string" ? rest.id : "unknown";
  // Stamp the kind here (same pattern as chat-respond): the renderer sends a
  // kind-less request and the backend routes on kind. Missing stamp previously
  // sent completion keystrokes into the turn pipeline as text-less messages.
  forwardChatLine(JSON.stringify({ kind: "complete", ...(cwd === undefined ? rest : { ...rest, cwd }) }), id);
});
ipcMain.handle("cloudcode:chat-status", (_event, request) => {
  if (typeof request !== "object" || request === null) return;
  const { workspaceId, repoId, ...rest } = request;
  let cwd;
  try {
    cwd = workspaceId === undefined ? undefined : repoCwdOf(workspaceId, repoId);
  } catch {
    cwd = undefined;
  }
  const id = typeof rest.id === "string" ? rest.id : "unknown";
  forwardChatLine(JSON.stringify({ kind: "status", ...(cwd === undefined ? rest : { ...rest, cwd }) }), id);
});
ipcMain.handle("cloudcode:chat-statusline-set", (_event, request) => {
  if (typeof request !== "object" || request === null) return;
  const { workspaceId, repoId, ...rest } = request;
  let cwd;
  try {
    cwd = workspaceId === undefined ? undefined : repoCwdOf(workspaceId, repoId);
  } catch {
    cwd = undefined;
  }
  const id = typeof rest.id === "string" ? rest.id : "unknown";
  forwardChatLine(JSON.stringify({ kind: "statusline-set", ...(cwd === undefined ? rest : { ...rest, cwd }) }), id);
});
ipcMain.handle("cloudcode:rename-session", (_event, workspaceId, sessionId, title) => host.renameSession(requireString(workspaceId, "workspace ID"), requireString(sessionId, "session ID"), requireString(title, "session title")));
ipcMain.handle("cloudcode:remove-session", (_event, workspaceId, sessionId) => host.removeSession(requireString(workspaceId, "workspace ID"), requireString(sessionId, "session ID")));
ipcMain.handle("cloudcode:close-application", () => window?.close());
ipcMain.handle("cloudcode:set-theme", (_event, name) => {
  // Titlebar Theme menu (Enter on a previewed theme): persist via the
  // backend so the choice survives restarts, then broadcast the theme event
  // the renderer applies. Previews never reach here, so browsing stays free
  // of persistence.
  forwardChatLine(JSON.stringify({ kind: "theme-set", name }), `menu-theme-${Date.now()}`);
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { quitting = true; stopChatBackend(); });
