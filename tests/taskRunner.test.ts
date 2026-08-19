import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectTrustStore } from "../src/agent/projectTrust.js";
import { TaskRunner, TaskStateConflictError, TaskTrustError } from "../src/agent/taskRunner.js";
import { linkPack } from "../src/agent/packLinks.js";
import { enablePack } from "../src/agent/packs.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function setup(): { root: string; source: string; config: string; runner: TaskRunner } {
  const root = mkdtempSync(join(tmpdir(), "cc-task-runner-"));
  roots.push(root);
  const source = join(root, "source");
  const config = join(root, "config");
  execFileSync("git", ["init", source], { windowsHide: true });
  git(source, ["config", "user.email", "test@example.com"]);
  git(source, ["config", "user.name", "Test User"]);
  mkdirSync(join(source, ".cloudcode"));
  writeFileSync(join(source, ".cloudcode", "task.json"), JSON.stringify({ profiles: {
    focused: { commands: [{ command: process.execPath, args: ["-e", "process.stdout.write('passed')"] }] }
  } }));
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "base"]);
  return {
    root, source, config,
    runner: new TaskRunner({
      configBase: config, worktreesBase: join(config, "worktrees"),
      trustStore: new ProjectTrustStore(join(config, "trust.json"))
    })
  };
}

function writePlan(worktree: string, planPath: string): void {
  const path = join(worktree, planPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Plan\n");
}

describe("TaskRunner", () => {
  it("starts from a dirty source without changing its worktree or index", async () => {
    const { source, runner } = setup();
    writeFileSync(join(source, "local.txt"), "unstaged\n");
    const before = git(source, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const task = await runner.start({ cwd: source, name: "Fix login timeout", now: new Date("2026-08-19") });
    expect(git(source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before);
    expect(task.state).toBe("planning");
    expect(task.planPath).toBe("docs/plans/2026-08-19-fix-login-timeout.md");
    expect(runner.show(task.taskId).worktreePath).toBe(task.worktreePath);
  }, 20_000);

  it("requires a written plan and explicit approval across reloads", async () => {
    const { source, runner } = setup();
    const task = await runner.start({ cwd: source, name: "Plan approval" });
    expect(() => runner.markPlanReady(task.taskId)).toThrow(TaskStateConflictError);
    writePlan(task.worktreePath, task.planPath);
    expect(runner.markPlanReady(task.taskId, "session-1")).toMatchObject({
      state: "awaitingApproval", sessionId: "session-1"
    });
    expect((await runner.resume(task.taskId)).state).toBe("awaitingApproval");
    expect((await runner.resume(task.taskId, true)).state).toBe("implementing");
  }, 20_000);

  it("runs trusted verification and stores bounded attributable evidence", async () => {
    const { source, runner } = setup();
    const task = await runner.start({ cwd: source, name: "Verify", verificationProfile: "focused" });
    writePlan(task.worktreePath, task.planPath);
    runner.markPlanReady(task.taskId);
    await runner.resume(task.taskId, true);
    await expect(runner.verify(task.taskId)).rejects.toThrow(TaskTrustError);
    const result = await runner.verify(task.taskId, { trustProjectConfig: true });
    expect(result.success).toBe(true);
    expect(result.commands[0].stdout).toBe("passed");
    const saved = runner.show(task.taskId);
    expect(saved.state).toBe("reviewReady");
    expect(saved.artifactPaths).toHaveLength(1);
    expect(JSON.parse(readFileSync(saved.artifactPaths[0], "utf8"))).toMatchObject({ profile: "focused", success: true });
  }, 20_000);

  it("records enabled packs, exposes their validations, and refuses content drift", async () => {
    const { root, source, config, runner } = setup();
    const pack = join(root, "pack");
    mkdirSync(pack);
    const validations = join(pack, "validations.json");
    writeFileSync(validations, JSON.stringify({ profiles: { smoke: { commands: [{
      command: process.execPath, args: ["-e", "process.stdout.write('pack passed')"]
    }] } } }));
    writeFileSync(join(pack, "cloudcode-pack.json"), JSON.stringify({
      schemaVersion: 1, name: "local", version: "1.0.0", description: "Local",
      capabilities: ["runProcess"], resources: { validations: "validations.json" }
    }));
    const link = linkPack(pack, config);
    enablePack("local", source, "providerOnly", config);
    git(source, ["add", ".cloudcode/packs.json"]);
    git(source, ["commit", "-m", "enable pack"]);

    const task = await runner.start({ cwd: source, name: "Pack verify", verificationProfile: "local:smoke" });
    expect(task.packs).toEqual([{ name: "local", version: "1.0.0", digest: link.digest }]);
    writePlan(task.worktreePath, task.planPath);
    runner.markPlanReady(task.taskId);
    await runner.resume(task.taskId, true);
    const result = await runner.verify(task.taskId, { trustProjectConfig: true });
    expect(result.commands[0].stdout).toBe("pack passed");

    writeFileSync(validations, JSON.stringify({ profiles: { smoke: { commands: [{ command: "changed" }] } } }));
    await expect(runner.resume(task.taskId)).rejects.toThrow(/stale|changed since task creation/);
  }, 20_000);

  it("reviews against the recorded base and safely removes only merged clean worktrees", async () => {
    const { source, runner } = setup();
    const cleanTask = await runner.start({ cwd: source, name: "Disposable" });
    await runner.remove(cleanTask.taskId, true);
    expect(existsSync(cleanTask.worktreePath)).toBe(false);
    expect(() => runner.show(cleanTask.taskId)).toThrow(/could not be loaded/);

    const task = await runner.start({ cwd: source, name: "Review" });
    writePlan(task.worktreePath, task.planPath);
    runner.markPlanReady(task.taskId);
    await runner.resume(task.taskId, true);
    writeFileSync(join(task.worktreePath, "feature.txt"), "feature\n");
    git(task.worktreePath, ["add", "."]);
    git(task.worktreePath, ["commit", "-m", "feature"]);
    const review = await runner.review(task.taskId);
    expect(review.report).toContain("feature.txt");
    expect(existsSync(review.artifactPath)).toBe(true);
    await expect(runner.remove(task.taskId, true)).rejects.toThrow(/unmerged commits/);
  }, 20_000);
});
