// Run after desktop:build with: node scripts/test-desktop-idle.mjs
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.env.CLOUDCODE_IDLE_TEST_PROFILE;
if (!profile) throw new Error("Run through scripts/test-desktop-idle.mjs");
app.setPath("userData", profile);
let window;
let failed = false;
async function run() {
try {
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      // The test preload supplies a mock bridge in the renderer world.
      contextIsolation: false, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
      preload: join(root, "tests/helpers/desktopIdlePreload.cjs"),
    },
  });
  await window.loadFile(join(root, "dist/renderer/index.html"));
  await delay(500);
  const initial = await window.webContents.executeJavaScript("window.idleProbe.requests");
  assert.equal(initial, 3, "Only initial footer, seed, and history completion queries should run");
  await window.webContents.executeJavaScript(`
    const paragraph = document.querySelector('.md-body p');
    if (!paragraph) throw new Error('Missing transcript');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    window.transcriptMutations = 0;
    window.observer = new MutationObserver(records => { window.transcriptMutations += records.length; });
    window.observer.observe(document.querySelector('.md-body'), { subtree: true, childList: true, characterData: true });
  `);
  // Cross at least one visible-window poll (hidden windows may poll at 10s).
  await delay(10_500);
  const result = await window.webContents.executeJavaScript(`({
    requests: window.idleProbe.requests,
    selection: getSelection().toString(),
    mutations: window.transcriptMutations
  })`);
  assert.ok(result.requests > initial && result.requests <= initial + 4, "Idle requests must remain bounded by polling");
  assert.equal(result.selection, "Selectable transcript text.");
  assert.equal(result.mutations, 0, "Unchanged Markdown must retain its DOM");
  await window.webContents.executeJavaScript(`
    document.querySelector('.resizer').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 260 }));
  `);
  await delay(50);
  assert.equal(await window.webContents.executeJavaScript("document.body.style.userSelect"), "none");
  await window.webContents.executeJavaScript("dispatchEvent(new Event('blur'))");
  await delay(50);
  assert.equal(await window.webContents.executeJavaScript("document.body.style.userSelect"), "");
  console.log(JSON.stringify({ ...result, resizeSelectionLockReleased: true }));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  window?.destroy();
  app.exit(failed ? 1 : 0);
}
}

// Electron waits for ESM evaluation before emitting ready; do not await
// whenReady at module scope or startup deadlocks.
void app.whenReady().then(run);
