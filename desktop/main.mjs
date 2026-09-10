import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DesktopShellHost } from "../dist/desktop/shellHost.js";
import { requireBranchName, requirePaths, requireString } from "../dist/desktop/ipcContract.js";
import { resolveNodeExecutable } from "../dist/desktop/runtime.js";
import { VERSION } from "../dist/version.js";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: desktop/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is one level above desktop/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..");
const host = new DesktopShellHost();
let window;
let chatChild;

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
  candidates.push(join(desktopDir, "..", "dist", "cli.js"));
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
  const devServer = process.env.CLOUDCODE_DESKTOP_DEV_SERVER;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(desktopDir, "dist", "index.html"));
}

ipcMain.handle("cloudcode:open-project", async () => {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return host.openProject(result.filePaths[0]);
});
ipcMain.handle("cloudcode:restore-projects", () => host.restoreProjects());
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
ipcMain.handle("cloudcode:chat-send", (_event, request) => {
  if (!chatChild) startChatBackend();
  chatChild?.stdin.write(`${JSON.stringify(request)}\n`);
});
ipcMain.handle("cloudcode:chat-abort", (_event, id) => {
  chatChild?.stdin.write(`${JSON.stringify({ kind: "abort", id })}\n`);
});
ipcMain.handle("cloudcode:chat-history", (_event, sessionId) => {
  chatChild?.stdin.write(`${JSON.stringify({ kind: "history", sessionId })}\n`);
});
ipcMain.handle("cloudcode:chat-respond", (_event, response) => {
  chatChild?.stdin.write(`${JSON.stringify({ kind: "respond", ...response })}\n`);
});
ipcMain.handle("cloudcode:close-application", () => window?.close());

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => stopChatBackend());
