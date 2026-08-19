import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskCoordinator } from "../src/agent/taskCoordinator.js";
import { TaskRunner } from "../src/agent/taskRunner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cc-coordinator-")); roots.push(root);
  const source = join(root, "source"); const base = join(root, "config");
  execFileSync("git", ["init", source]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: source });
  writeFileSync(join(source, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: source }); execFileSync("git", ["commit", "-m", "base"], { cwd: source });
  const runner = new TaskRunner({ configBase: base, worktreesBase: join(base, "worktrees") });
  return { root, source, base, runner, coordinator: new TaskCoordinator({ configBase: base, runner }) };
}

async function approved(runner: TaskRunner, source: string) {
  const parent = await runner.start({ cwd: source, name: "parent" });
  const path = join(parent.worktreePath, parent.planPath); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "# Plan\n");
  runner.markPlanReady(parent.taskId); await runner.resume(parent.taskId, true); return parent.taskId;
}

describe("task coordinator", () => {
  it("creates isolated workers with durable parent references and one provider/model", async () => {
    const { runner, source, coordinator } = setup(); const parentTaskId = await approved(runner, source);
    const worker = await coordinator.addWorker({
      parentTaskId, role: "implement", ownedPaths: ["src/api"], provider: "local", model: "model-a"
    });
    expect(worker.manifest).toMatchObject({ parentTaskId, workerRole: "implement", ownedPaths: ["src/api"] });
    expect(coordinator.refresh(parentTaskId).children[0]).toMatchObject({ taskId: worker.manifest.taskId, provider: "local" });
    await expect(coordinator.addWorker({
      parentTaskId, role: "research", provider: "other", model: "model-b", concurrency: 2, explicitParallel: true
    })).rejects.toThrow(/must use local\/model-a/);
  }, 20_000);

  it("requires explicit parallel acknowledgement and rejects overlapping implementation paths", async () => {
    const { runner, source, coordinator } = setup(); const parentTaskId = await approved(runner, source);
    await coordinator.addWorker({ parentTaskId, role: "implement", ownedPaths: ["src"], provider: "local", model: "m" });
    await expect(coordinator.addWorker({
      parentTaskId, role: "research", provider: "local", model: "m", concurrency: 2
    })).rejects.toThrow(/--parallel/);
    await expect(coordinator.addWorker({
      parentTaskId, role: "implement", ownedPaths: ["src/api"], provider: "local", model: "m",
      concurrency: 2, explicitParallel: true
    })).rejects.toThrow(/overlaps/);
  }, 20_000);

  it("freezes verify workers at a clean implementation commit", async () => {
    const { runner, source, coordinator } = setup(); const parentTaskId = await approved(runner, source);
    const implementation = await coordinator.addWorker({
      parentTaskId, role: "implement", ownedPaths: ["src"], provider: "local", model: "m"
    });
    const verify = await coordinator.addWorker({
      parentTaskId, role: "verify", targetTaskId: implementation.manifest.taskId,
      provider: "local", model: "m", concurrency: 2, explicitParallel: true
    });
    expect(verify.reference.targetCommit).toBe(implementation.manifest.baseCommit);
    expect(verify.manifest.baseCommit).toBe(verify.reference.targetCommit);
  }, 20_000);
});
