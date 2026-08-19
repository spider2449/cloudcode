import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const OUTPUT_LIMIT = 200 * 1024;
const ERROR_LIMIT = 32 * 1024;

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitExecResult>;

export interface GitReviewSnapshot {
  isGitRepo: boolean;
  status: string;
  diff: string;
  truncated: boolean;
  error?: string;
}

function appendCapped(current: Buffer[], size: number, chunk: Buffer, limit: number): { size: number; truncated: boolean } {
  if (size >= limit) return { size, truncated: true };
  const remaining = limit - size;
  current.push(chunk.subarray(0, remaining));
  return { size: size + Math.min(chunk.length, remaining), truncated: chunk.length > remaining };
}

export const defaultGitRunner: GitRunner = (args, cwd) => new Promise(resolvePromise => {
  const child = spawn("git", args, { cwd, windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let truncated = false;
  let settled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    const appended = appendCapped(stdout, stdoutSize, chunk, OUTPUT_LIMIT);
    stdoutSize = appended.size;
    truncated ||= appended.truncated;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const appended = appendCapped(stderr, stderrSize, chunk, ERROR_LIMIT);
    stderrSize = appended.size;
    truncated ||= appended.truncated;
  });
  child.on("error", error => {
    if (settled) return;
    settled = true;
    resolvePromise({ code: -1, stdout: "", stderr: error.message, truncated });
  });
  child.on("close", code => {
    if (settled) return;
    settled = true;
    resolvePromise({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      truncated
    });
  });
});

function untrackedPaths(status: string): string[] {
  return status.split("\0")
    .filter(record => record.startsWith("? "))
    .map(record => record.slice(2));
}

function isInside(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const target = resolve(path);
  const left = process.platform === "win32" ? root.toLowerCase() : root;
  const right = process.platform === "win32" ? target.toLowerCase() : target;
  return right === left || right.startsWith(left + sep);
}

function renderUntracked(cwd: string, paths: string[], remaining: number): { content: string; truncated: boolean } {
  let content = "";
  let truncated = false;
  for (const rawPath of paths) {
    const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    if (!isInside(path, cwd)) continue;
    try {
      const info = lstatSync(path);
      if (!info.isFile()) continue;
      const bytes = readFileSync(path);
      const name = relative(cwd, path).replaceAll("\\", "/");
      const body = bytes.includes(0)
        ? `Binary untracked file (${bytes.length} bytes)\n`
        : bytes.toString("utf8").split("\n").map(line => `+${line}`).join("\n") + "\n";
      const block = `--- /dev/null\n+++ b/${name}\n${body}`;
      if (Buffer.byteLength(content + block) > remaining) {
        truncated = true;
        break;
      }
      content += block;
    } catch { /* file may disappear between status and read */ }
  }
  return { content, truncated };
}

export async function collectGitReview(
  cwd: string,
  stagedOnly = false,
  runner: GitRunner = defaultGitRunner
): Promise<GitReviewSnapshot> {
  const probe = await runner(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    return { isGitRepo: false, status: "", diff: "", truncated: probe.truncated, error: probe.stderr.trim() || "Not a Git worktree." };
  }
  const status = await runner(["status", "--porcelain=v2", "-z", "--untracked-files=all"], cwd);
  const shared = ["--no-ext-diff", "--no-textconv"];
  const staged = await runner(["diff", "--cached", ...shared, "--"], cwd);
  const unstaged = stagedOnly ? undefined : await runner(["diff", ...shared, "--"], cwd);
  let diff = staged.stdout ? `# Staged changes\n${staged.stdout}` : "";
  if (unstaged?.stdout) diff += `${diff ? "\n" : ""}# Unstaged changes\n${unstaged.stdout}`;
  let truncated = probe.truncated || status.truncated || staged.truncated || (unstaged?.truncated ?? false);
  if (!stagedOnly && Buffer.byteLength(diff) < OUTPUT_LIMIT) {
    const untracked = renderUntracked(cwd, untrackedPaths(status.stdout), OUTPUT_LIMIT - Buffer.byteLength(diff));
    if (untracked.content) diff += `${diff ? "\n# Untracked files\n" : "# Untracked files\n"}${untracked.content}`;
    truncated ||= untracked.truncated;
  }
  if (Buffer.byteLength(diff) > OUTPUT_LIMIT) {
    diff = Buffer.from(diff).subarray(0, OUTPUT_LIMIT).toString("utf8");
    truncated = true;
  }
  const errors = [status, staged, unstaged].filter((item): item is GitExecResult => item !== undefined && item.code !== 0)
    .map(item => item.stderr.trim()).filter(Boolean);
  return {
    isGitRepo: true,
    status: status.stdout.split("\0").filter(Boolean).join("\n"),
    diff,
    truncated,
    error: errors.length > 0 ? errors.join("\n") : undefined
  };
}

export async function collectGitReviewAgainstBase(
  cwd: string,
  baseCommit: string,
  runner: GitRunner = defaultGitRunner
): Promise<GitReviewSnapshot> {
  const probe = await runner(["rev-parse", "--verify", `${baseCommit}^{commit}`], cwd);
  if (probe.code !== 0) {
    return { isGitRepo: false, status: "", diff: "", truncated: probe.truncated, error: probe.stderr.trim() || "Base commit is unavailable." };
  }
  const status = await runner(["status", "--porcelain=v2", "-z", "--untracked-files=all"], cwd);
  const committed = await runner(["diff", "--no-ext-diff", "--no-textconv", `${baseCommit}...HEAD`, "--"], cwd);
  const working = await runner(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"], cwd);
  let diff = committed.stdout ? `# Committed changes since base\n${committed.stdout}` : "";
  if (working.stdout) diff += `${diff ? "\n" : ""}# Uncommitted tracked changes\n${working.stdout}`;
  let truncated = probe.truncated || status.truncated || committed.truncated || working.truncated;
  if (Buffer.byteLength(diff) < OUTPUT_LIMIT) {
    const untracked = renderUntracked(cwd, untrackedPaths(status.stdout), OUTPUT_LIMIT - Buffer.byteLength(diff));
    if (untracked.content) diff += `${diff ? "\n" : ""}# Untracked files\n${untracked.content}`;
    truncated ||= untracked.truncated;
  }
  if (Buffer.byteLength(diff) > OUTPUT_LIMIT) {
    diff = Buffer.from(diff).subarray(0, OUTPUT_LIMIT).toString("utf8");
    truncated = true;
  }
  const errors = [status, committed, working].filter(item => item.code !== 0)
    .map(item => item.stderr.trim()).filter(Boolean);
  return {
    isGitRepo: true,
    status: status.stdout.split("\0").filter(Boolean).join("\n"),
    diff,
    truncated,
    error: errors.length ? errors.join("\n") : undefined
  };
}
