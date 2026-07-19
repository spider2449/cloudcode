import { spawnSync } from "node:child_process";

export interface ExecResult {
  stdout: string | null;
  status: number | null;
}
export type Exec = (args: string[], opts?: { inherit?: boolean }) => ExecResult;

// npm is npm.cmd on Windows, which requires a shell to resolve.
const npmExec: Exec = (args, opts = {}) => {
  const res = spawnSync("npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: opts.inherit ? "inherit" : "pipe"
  });
  return { stdout: res.stdout ?? null, status: res.status };
};

export const UPDATE_INSTRUCTIONS = [
  "cloudcode does not appear to be installed via npm. Update options:",
  "  npm:        npm install -g cloudcode@latest",
  "  installer:  download the latest release from https://github.com/spider2449/cloudcode/releases",
  "  source:     git pull && npm install && npm run build"
].join("\n");

export function isNpmGlobalInstall(npmLsOutput: string): boolean {
  return /\bcloudcode@\d/.test(npmLsOutput);
}

export function runUpdate(exec: Exec = npmExec, log: (s: string) => void = console.log): number {
  const ls = exec(["ls", "-g", "cloudcode", "--depth=0"]);
  if (!isNpmGlobalInstall(ls.stdout ?? "")) {
    log(UPDATE_INSTRUCTIONS);
    return 0;
  }
  log("Updating: npm install -g cloudcode@latest");
  const res = exec(["install", "-g", "cloudcode@latest"], { inherit: true });
  return res.status === 0 ? 0 : 1;
}
