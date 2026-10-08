import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = mkdtempSync(join(tmpdir(), "cloudcode-project-menu-test-"));
try {
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(root, "tests/desktop-project-menu.electron.mjs")], {
      cwd: root, stdio: "inherit", windowsHide: true,
      env: { ...process.env, CLOUDCODE_IDLE_TEST_PROFILE: profile },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Project menu probe timed out")); }, 30_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => { clearTimeout(timeout); resolveExit(code ?? 1); });
  });
} finally {
  const withinTemp = relative(resolve(tmpdir()), resolve(profile));
  if (withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp)) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
