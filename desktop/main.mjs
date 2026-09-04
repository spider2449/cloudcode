import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as pty from "node-pty";
import { DesktopShellHost } from "../dist/desktop/shellHost.js";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: desktop/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is one level above desktop/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..");
const host = new DesktopShellHost();
let window;
let terminal;

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

function resolveNodeExecutable() {
  const configured = process.env.CLOUDCODE_NODE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const npmNode = process.env.npm_node_execpath;
  if (npmNode && existsSync(npmNode)) return npmNode;
  try {
    const found = execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/).find(path => path && existsSync(path));
    if (found) return found;
  } catch { /* reported with a desktop-specific message below */ }
  throw new Error("CloudCode Desktop requires node.exe. Set CLOUDCODE_NODE_EXECUTABLE to its absolute path.");
}

function startTerminal(workspaceId, sessionId, columns = 100, rows = 30) {
  if (sessionId) host.assertSession(workspaceId, sessionId);
  stopTerminal();
  const args = [join(projectRoot, "dist", "cli.js")];
  if (sessionId) args.push("--session", sessionId);
  const executable = resolveNodeExecutable();
  const environment = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor"
  };
  const spawned = pty.spawn(executable, args, {
    name: "xterm-256color",
    cols: Math.max(20, columns),
    rows: Math.max(10, rows),
    cwd: host.cwd(workspaceId),
    env: environment
  });
  terminal = spawned;
  spawned.onData(data => {
    send("cloudcode:terminal-data", data);
  });
  spawned.onExit(({ exitCode }) => {
    if (terminal !== spawned) return;
    terminal = undefined;
    send("cloudcode:terminal-exit", { exitCode });
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 880, minWidth: 900, minHeight: 600, backgroundColor: "#101216",
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
ipcMain.handle("cloudcode:refresh-workspace", (_event, workspaceId) => host.refresh(workspaceId));
ipcMain.handle("cloudcode:git-state", (_event, workspaceId) => host.gitState(workspaceId));
ipcMain.handle("cloudcode:terminal-start", (_event, workspaceId, sessionId, columns, rows) => startTerminal(workspaceId, sessionId, columns, rows));
ipcMain.handle("cloudcode:terminal-write", (_event, data) => terminal?.write(data));
ipcMain.handle("cloudcode:terminal-resize", (_event, columns, rows) => {
  if (terminal) terminal.resize(Math.max(20, columns), Math.max(10, rows));
});
ipcMain.handle("cloudcode:close-application", () => window?.close());

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => stopTerminal());
