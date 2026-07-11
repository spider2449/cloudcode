// Shared runtime for single-file executable entries (Bun-only).
// Extracts the embedded Claude Code native CLI to a stable per-user location
// (embedded bunfs paths are not directly spawnable) and registers it with the
// session layer, then starts the normal CLI.
import { chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setEmbeddedWelcome } from "../src/ui/welcome.js";
import { setNativeCliPath } from "../src/agent/nativeCli.js";

export async function startFromBinary(
  welcomeText: string,
  embeddedCliPath: string,
  cliFileName: string
): Promise<void> {
  setEmbeddedWelcome(welcomeText);

  const src = Bun.file(embeddedCliPath);
  const dir = join(homedir(), ".cloudcode", "bin");
  const dest = join(dir, cliFileName);
  const upToDate = existsSync(dest) && statSync(dest).size === src.size;
  if (!upToDate) {
    mkdirSync(dir, { recursive: true });
    // Write to a temp name then rename, so a concurrent launch never spawns
    // a half-written binary.
    const tmp = join(dir, `.${cliFileName}.${process.pid}.tmp`);
    await Bun.write(tmp, src);
    chmodSync(tmp, 0o755);
    try {
      renameSync(tmp, dest);
    } catch {
      // Windows can refuse the rename while another process holds dest open.
      // The temp copy we just wrote is complete, so spawn that instead.
      setNativeCliPath(tmp);
      await import("../src/cli.js");
      return;
    }
  }
  setNativeCliPath(dest);
  await import("../src/cli.js");
}
