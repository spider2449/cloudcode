// Clean the isolated profile only after Electron releases its Windows locks.
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = mkdtempSync(join(tmpdir(), "cloudcode-idle-test-"));
try {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(root, "tests/desktop-idle-selection.electron.mjs")], {
      cwd: root, stdio: "inherit", windowsHide: true,
      env: { ...process.env, CLOUDCODE_IDLE_TEST_PROFILE: profile },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron probe timed out")); }, 30_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", exitCode => { clearTimeout(timeout); resolveExit(exitCode ?? 1); });
  });
  process.exitCode = code;
} finally {
  const withinTemp = relative(resolve(tmpdir()), resolve(profile));
  if (withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp)) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
