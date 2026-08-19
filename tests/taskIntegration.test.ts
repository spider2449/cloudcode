import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskCoordinator } from "../src/agent/taskCoordinator.js";
import { TaskIntegration } from "../src/agent/taskIntegration.js";
import { TaskRunner } from "../src/agent/taskRunner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cc-integrate-")); roots.push(root);
  const source = join(root, "source"); const base = join(root, "config");
  execFileSync("git", ["init", source]); git(source, ["config", "user.email", "test@example.com"]); git(source, ["config", "user.name", "Test User"]);
  mkdirSync(join(source, "src")); writeFileSync(join(source, "src", "base.txt"), "base\n"); git(source, ["add", "."]); git(source, ["commit", "-m", "base"]);
  const runner = new TaskRunner({ configBase: base, worktreesBase: join(base, "worktrees") });
  const parent = await runner.start({ cwd: source, name: "parent" });
  const plan = join(parent.worktreePath, parent.planPath); mkdirSync(dirname(plan), { recursive: true }); writeFileSync(plan, "# Plan\n");
  git(parent.worktreePath, ["add", "."]); git(parent.worktreePath, ["commit", "-m", "plan"]);
  runner.markPlanReady(parent.taskId); await runner.resume(parent.taskId, true);
  const coordinator = new TaskCoordinator({ configBase: base, runner });
  const worker = await coordinator.addWorker({ parentTaskId: parent.taskId, role: "implement", ownedPaths: ["src"], provider: "local", model: "m" });
  const workerPlan = join(worker.manifest.worktreePath, worker.manifest.planPath); mkdirSync(dirname(workerPlan), { recursive: true }); writeFileSync(workerPlan, "# Worker plan\n");
  runner.markPlanReady(worker.manifest.taskId); await runner.resume(worker.manifest.taskId, true);
  return { base, runner, parent: runner.show(parent.taskId), child: runner.show(worker.manifest.taskId) };
}

describe("task integration", () => {
  it("previews exact commits and applies them only after explicit approval", async () => {
    const { base, runner, parent, child } = await setup();
    writeFileSync(join(child.worktreePath, "src", "feature.txt"), "feature\n");
    git(child.worktreePath, ["add", "."]); git(child.worktreePath, ["commit", "-m", "feature"]);
    await runner.review(child.taskId);
    const integration = new TaskIntegration({ configBase: base });
    const preview = await integration.integrate(parent.taskId, child.taskId, false);
    expect(preview).toMatchObject({ conflicts: false, changedFiles: expect.arrayContaining(["src/feature.txt"]) });
    expect(existsSync(join(parent.worktreePath, "src", "feature.txt"))).toBe(false);
    await integration.integrate(parent.taskId, child.taskId, true);
    expect(existsSync(join(parent.worktreePath, "src", "feature.txt"))).toBe(true);
  }, 30_000);

  it("rejects committed paths outside worker ownership", async () => {
    const { base, runner, parent, child } = await setup();
    writeFileSync(join(child.worktreePath, "outside.txt"), "outside\n");
    git(child.worktreePath, ["add", "."]); git(child.worktreePath, ["commit", "-m", "outside"]);
    await runner.review(child.taskId);
    const integration = new TaskIntegration({ configBase: base });
    const preview = await integration.preview(parent.taskId, child.taskId);
    expect(preview.ownershipViolations).toContain("outside.txt");
    await expect(integration.integrate(parent.taskId, child.taskId, true)).rejects.toThrow(/outside its ownership/);
  }, 30_000);
});
