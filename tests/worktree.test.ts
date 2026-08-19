import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTaskManifest } from "../src/agent/taskManifest.js";
import {
  createTaskWorktree, removeTaskWorktree, runGit, validateTaskWorktree, type WorktreeIdentity
} from "../src/agent/worktree.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function repository(): { root: string; source: string; worktrees: string } {
  const root = mkdtempSync(join(tmpdir(), "cc-worktree-"));
  roots.push(root);
  const source = join(root, "source");
  const worktrees = join(root, "owned-worktrees");
  execFileSync("git", ["init", source], { windowsHide: true });
  git(source, ["config", "user.email", "test@example.com"]);
  git(source, ["config", "user.name", "Test User"]);
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "base"]);
  return { root, source, worktrees };
}

function asManifest(identity: WorktreeIdentity) {
  return newTaskManifest({
    taskId: identity.worktreePath.split(/[\\/]/).at(-1) ?? "task", ...identity,
    planPath: "docs/plans/2026-08-19-task.md", networkMode: "providerOnly"
  });
}

describe("task worktrees", () => {
  it("creates an isolated branch without changing source worktree or index", async () => {
    const repo = repository();
    writeFileSync(join(repo.source, "untracked.txt"), "keep me\n");
    const beforeStatus = git(repo.source, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const beforeHead = git(repo.source, ["rev-parse", "HEAD"]);
    const calls: string[][] = [];
    const identity = await createTaskWorktree({
      cwd: repo.source, taskId: "12345678-task", name: "Fix login timeout", worktreesBase: repo.worktrees,
      runner: async (args, cwd) => { calls.push(args); return runGit(args, cwd); }
    });
    expect(git(repo.source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
    expect(git(repo.source, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(existsSync(identity.worktreePath)).toBe(true);
    expect(identity.branch).toMatch(/^cloudcode\/task\/12345678-fix-login-timeout$/);
    expect(calls.some(args => ["fetch", "push", "pull"].includes(args[0]))).toBe(false);
    await expect(validateTaskWorktree(asManifest(identity))).resolves.toMatchObject({ clean: true });
  });

  it("refuses identity drift and dirty cleanup", async () => {
    const repo = repository();
    const identity = await createTaskWorktree({
      cwd: repo.source, taskId: "abcdefgh-task", name: "Task", worktreesBase: repo.worktrees
    });
    const manifest = asManifest(identity);
    await expect(validateTaskWorktree({ ...manifest, branch: "wrong" })).rejects.toThrow(/branch drifted/);
    writeFileSync(join(identity.worktreePath, "dirty.txt"), "dirty\n");
    await expect(removeTaskWorktree({ manifest, yes: true, worktreesBase: repo.worktrees }))
      .rejects.toThrow(/dirty/);
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it("refuses unmerged commits and removes only a clean merged branch with --yes", async () => {
    const repo = repository();
    const identity = await createTaskWorktree({
      cwd: repo.source, taskId: "commit-task", name: "Commit", worktreesBase: repo.worktrees
    });
    const manifest = asManifest(identity);
    writeFileSync(join(identity.worktreePath, "change.txt"), "change\n");
    git(identity.worktreePath, ["add", "change.txt"]);
    git(identity.worktreePath, ["commit", "-m", "task change"]);
    await expect(removeTaskWorktree({ manifest, yes: true, worktreesBase: repo.worktrees }))
      .rejects.toThrow(/unmerged commits/);
    expect(existsSync(identity.worktreePath)).toBe(true);

    git(repo.source, ["merge", "--ff-only", identity.branch]);
    await expect(removeTaskWorktree({ manifest, yes: false, worktreesBase: repo.worktrees })).rejects.toThrow(/--yes/);
    await removeTaskWorktree({ manifest, yes: true, worktreesBase: repo.worktrees });
    expect(existsSync(identity.worktreePath)).toBe(false);
  });
});
