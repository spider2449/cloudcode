import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.env.CLOUDCODE_IDLE_TEST_PROFILE;
if (!profile) throw new Error("Run through scripts/test-desktop-project-menu.mjs");
app.setPath("userData", profile);
let window;
async function run() {
  let code = 0;
  try {
    window = new BrowserWindow({ show: false, width: 1428, height: 900,
      webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false,
        preload: join(root, "tests/helpers/desktopProjectMenuPreload.cjs") } });
    window.webContents.on("console-message", event => console.log(event.message));
    window.webContents.on("preload-error", (_event, _path, error) => console.error(error));
    await window.loadFile(join(root, "dist/renderer/index.html"));
    await delay(300);
    for (const height of [870, 300]) {
      window.setContentSize(1428, height);
      await delay(100);
      await window.webContents.executeJavaScript(`
        document.querySelector('.project-menu-trigger').click();
      `);
      await delay(100);
      await window.webContents.executeJavaScript(`
        document.querySelector('.project-menu-popup').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      `);
      await delay(100);
      const result = await window.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('.project-menu-popup');
        const bounds = menu.getBoundingClientRect();
        const last = menu.lastElementChild.getBoundingClientRect();
        return { height: innerHeight, top: bounds.top, bottom: bounds.bottom,
          lastTop: last.top, lastBottom: last.bottom, count: menu.children.length,
          scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight };
      })()`);
      assert.equal(result.count, 30);
      assert.ok(result.top >= 8 && result.bottom <= result.height - 8, JSON.stringify(result));
      assert.ok(result.scrollHeight > result.clientHeight);
      assert.ok(result.lastTop >= result.top && result.lastBottom <= result.bottom, "Last option must be fully visible");
      console.log(JSON.stringify(result));
      if (height === 870) {
        mkdirSync(join(root, "release"), { recursive: true });
        writeFileSync(join(root, "release/desktop-project-menu.png"), (await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript(`
        document.querySelector('.project-menu-popup').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      `);
      await delay(50);
    }
    await window.webContents.executeJavaScript(`
      document.querySelector('.project-menu-trigger').click();
    `);
    await delay(100);
    await window.webContents.executeJavaScript(`
      document.querySelector('[aria-label="Remove Project 1 from project list"]').click();
    `);
    await delay(100);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-label').textContent"), "Project 2");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-trigger').getAttribute('aria-expanded')"), "true");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.project-menu-option').length"), 29);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Remove Project 1 from project list\"]') === null"), true);
    assert.equal(await window.webContents.executeJavaScript("document.activeElement.getAttribute('aria-label')"), "Remove Project 2 from project list");
    await window.webContents.executeJavaScript(`
      document.querySelector('.project-menu-popup').scrollTop = 300;
    `);
    await delay(100);
    const scrollBefore = await window.webContents.executeJavaScript("document.querySelector('.project-menu-popup').scrollTop");
    for (const project of [10, 11]) {
      await window.webContents.executeJavaScript(`
        document.querySelector('[aria-label="Remove Project ${project} from project list"]').click();
      `);
      await delay(100);
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-trigger').getAttribute('aria-expanded')"), "true");
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-popup').scrollTop"), scrollBefore);
    }
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.project-menu-option').length"), 27);
    for (let index = 0; index < 27; index++) {
      await window.webContents.executeJavaScript("document.querySelector('.project-menu-remove').click()");
      await delay(30);
    }
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-popup') === null"), true);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.project-menu-trigger').disabled"), true);
    console.log("Continuous removal, scroll preservation, active fallback, and empty-list closure passed.");
  } catch (error) { code = 1; console.error(error); }
  finally { window?.destroy(); app.exit(code); }
}
void app.whenReady().then(run);
