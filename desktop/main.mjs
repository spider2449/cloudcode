import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as pty from "node-pty";
import { DesktopShellHost } from "../dist/desktop/shellHost.js";
import { requireBranchName, requireDimension, requireOptionalString, requirePaths, requireString } from "../dist/desktop/ipcContract.js";
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
let terminal;
let terminalGeneration;

function send(channel, payload) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

function stopTerminal() {
  if (!terminal) return;
  const active = terminal;
  terminal = undefined;
  try { active.kill(); } catch { /* the PTY may already have exited */ }
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

function startTerminal(workspaceId, sessionId, columns, rows, generation) {
  if (sessionId) host.assertSession(workspaceId, sessionId);
  stopTerminal();
  let cliPath;
  let executable;
  try {
    cliPath = resolveCliPath();
    executable = resolveNodeExecutable();
  } catch (err) {
    // Report inside the terminal pane (the renderer fires startTerminal
    // without awaiting, so throwing here would be an invisible rejection).
    send("cloudcode:terminal-data", { generation, data: `\r\n${err instanceof Error ? err.message : err}\r\n` });
    send("cloudcode:terminal-exit", { generation, exitCode: 1 });
    return;
  }
  const args = [cliPath];
  if (sessionId) args.push("--session", sessionId);
  const environment = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...(executable === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {})
  };
  const spawned = pty.spawn(executable, args, {
    name: "xterm-256color",
    cols: Math.max(20, columns),
    rows: Math.max(10, rows),
    cwd: host.cwd(workspaceId),
    env: environment
  });
  terminal = spawned;
  terminalGeneration = generation;
  spawned.onData(data => {
    if (terminal !== spawned || terminalGeneration !== generation) return;
    send("cloudcode:terminal-data", { generation, data });
  });
  spawned.onExit(({ exitCode }) => {
    if (terminal !== spawned) return;
    terminal = undefined;
    send("cloudcode:terminal-exit", { generation, exitCode });
  });
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
ipcMain.handle("cloudcode:terminal-start", (_event, workspaceId, sessionId, columns, rows, generation) => startTerminal(requireString(workspaceId, "workspace ID"), requireOptionalString(sessionId, "session ID"), requireDimension(columns, "terminal columns"), requireDimension(rows, "terminal rows"), requireString(generation, "terminal generation")));
ipcMain.handle("cloudcode:terminal-write", (_event, data) => terminal?.write(requireString(data, "terminal data", true)));
ipcMain.handle("cloudcode:terminal-resize", (_event, columns, rows) => {
  if (terminal) terminal.resize(Math.max(20, requireDimension(columns, "terminal columns")), Math.max(10, requireDimension(rows, "terminal rows")));
});
ipcMain.handle("cloudcode:close-application", () => window?.close());

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => stopTerminal());
