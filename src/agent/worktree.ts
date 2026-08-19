import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { configDir } from "./providers.js";
import type { TaskManifest } from "./taskManifest.js";

export interface GitResult { code: number; stdout: string; stderr: string; truncated: boolean; }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const OUTPUT_LIMIT = 256 * 1024;

export const runGit: GitRunner = (args, cwd) => new Promise(resolvePromise => {
  execFile("git", args, { cwd, windowsHide: true, maxBuffer: OUTPUT_LIMIT, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : error ? -1 : 0;
    resolvePromise({
      code, stdout: stdout ?? "", stderr: stderr ?? "",
      truncated: (error as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    });
  });
});

export interface WorktreeIdentity {
  repositoryId: string;
  sourcePath: string;
  commonDir: string;
  worktreePath: string;
  baseCommit: string;
  branch: string;
}

function canonical(path: string): string {
  let value: string;
  try { value = realpathSync.native(resolve(path)); } catch { value = resolve(path); }
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function inside(path: string, root: string): boolean {
  const child = canonical(path);
  const parent = canonical(root);
  return child === parent || child.startsWith(parent + sep);
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return slug || "task";
}

async function requireGit(args: string[], cwd: string, runner: GitRunner): Promise<string> {
  const result = await runner(args, cwd);
  if (result.code !== 0 || result.truncated) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

export async function createTaskWorktree(input: {
  cwd: string; taskId: string; name: string; base?: string; worktreesBase?: string; runner?: GitRunner;
}): Promise<WorktreeIdentity> {
  const runner = input.runner ?? runGit;
  const version = await requireGit(["--version"], input.cwd, runner);
  const match = /git version (\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 20)) {
    throw new Error(`Unsupported Git version: ${version}. Need Git >= 2.20.`);
  }
  if (await requireGit(["rev-parse", "--is-bare-repository"], input.cwd, runner) === "true") {
    throw new Error("Bare repositories are not supported for tasks.");
  }
  const superproject = await requireGit(["rev-parse", "--show-superproject-working-tree"], input.cwd, runner);
  if (superproject) throw new Error("Starting a task from a submodule is ambiguous and is not supported.");
  const sourcePath = canonical(await requireGit(["rev-parse", "--show-toplevel"], input.cwd, runner));
  const commonRaw = await requireGit(["rev-parse", "--git-common-dir"], sourcePath, runner);
  const commonDir = canonical(isAbsolute(commonRaw) ? commonRaw : resolve(sourcePath, commonRaw));
  const baseCommit = await requireGit(["rev-parse", "--verify", `${input.base ?? "HEAD"}^{commit}`], sourcePath, runner);
  const repositoryId = createHash("sha256").update(commonDir).digest("hex").slice(0, 20);
  const branch = `cloudcode/task/${input.taskId.slice(0, 8)}-${safeSlug(input.name)}`;
  const collision = await runner(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], sourcePath);
  if (collision.code === 0) throw new Error(`Task branch already exists: ${branch}`);
  if (collision.code !== 1) throw new Error(`Could not check task branch collision: ${collision.stderr.trim()}`);
  const root = input.worktreesBase ?? resolve(configDir(), "worktrees");
  const worktreePath = resolve(root, repositoryId, input.taskId);
  if (!inside(worktreePath, root)) throw new Error("Resolved task worktree escaped the configured worktree root.");
  mkdirSync(dirname(worktreePath), { recursive: true });
  await requireGit(["worktree", "add", "-b", branch, worktreePath, baseCommit], sourcePath, runner);
  return { repositoryId, sourcePath, commonDir, worktreePath: canonical(worktreePath), baseCommit, branch };
}

function registeredPaths(porcelain: string): string[] {
  return porcelain.split(/\r?\n/).filter(line => line.startsWith("worktree ")).map(line => canonical(line.slice(9)));
}

export async function validateTaskWorktree(
  manifest: TaskManifest, runner: GitRunner = runGit
): Promise<{ head: string; clean: boolean }> {
  const listed = await requireGit(["worktree", "list", "--porcelain"], manifest.sourcePath, runner);
  if (!registeredPaths(listed).includes(canonical(manifest.worktreePath))) throw new Error("Task worktree is not registered with Git.");
  const root = canonical(await requireGit(["rev-parse", "--show-toplevel"], manifest.worktreePath, runner));
  if (root !== canonical(manifest.worktreePath)) throw new Error("Task worktree canonical path does not match its manifest.");
  const commonRaw = await requireGit(["rev-parse", "--git-common-dir"], manifest.worktreePath, runner);
  const common = canonical(isAbsolute(commonRaw) ? commonRaw : resolve(manifest.worktreePath, commonRaw));
  if (common !== canonical(manifest.commonDir)) throw new Error("Task repository common directory does not match its manifest.");
  const branch = await requireGit(["symbolic-ref", "--quiet", "--short", "HEAD"], manifest.worktreePath, runner);
  if (branch !== manifest.branch) throw new Error(`Task branch drifted: expected ${manifest.branch}, found ${branch}.`);
  const head = await requireGit(["rev-parse", "HEAD"], manifest.worktreePath, runner);
  await requireGit(["merge-base", "--is-ancestor", manifest.baseCommit, head], manifest.worktreePath, runner);
  const status = await requireGit(["status", "--porcelain=v1", "--untracked-files=all"], manifest.worktreePath, runner);
  return { head, clean: status === "" };
}

export async function removeTaskWorktree(input: {
  manifest: TaskManifest; yes: boolean; worktreesBase?: string; runner?: GitRunner;
}): Promise<void> {
  if (!input.yes) throw new Error("Task removal requires --yes.");
  const runner = input.runner ?? runGit;
  const root = input.worktreesBase ?? resolve(configDir(), "worktrees");
  if (!inside(input.manifest.worktreePath, root)) throw new Error("Refusing to remove a worktree outside the configured task root.");
  const state = await validateTaskWorktree(input.manifest, runner);
  if (!state.clean) throw new Error("Refusing to remove a dirty task worktree.");
  const sourceHead = await requireGit(["rev-parse", "HEAD"], input.manifest.sourcePath, runner);
  const merged = await runner(["merge-base", "--is-ancestor", state.head, sourceHead], input.manifest.sourcePath);
  if (merged.code !== 0) throw new Error("Refusing to remove a task branch with unmerged commits.");
  await requireGit(["worktree", "remove", input.manifest.worktreePath], input.manifest.sourcePath, runner);
  await requireGit(["branch", "-d", input.manifest.branch], input.manifest.sourcePath, runner);
}
