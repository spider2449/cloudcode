import { describe, expect, it, vi } from "vitest";
import { runTaskCommand, type TaskCommandRunner } from "../src/commands/cli/task.js";
import { newTaskManifest, transitionTask } from "../src/agent/taskManifest.js";
import { TaskStateConflictError } from "../src/agent/taskRunner.js";
import type { TaskCoordinator } from "../src/agent/taskCoordinator.js";
import type { TaskIntegration } from "../src/agent/taskIntegration.js";

function manifest() {
  return newTaskManifest({
    taskId: "task-1", repositoryId: "repo", sourcePath: "/source", commonDir: "/source/.git",
    worktreePath: "/worktree", baseCommit: "abc", branch: "cloudcode/task/task-1",
    planPath: "docs/plans/2026-08-19-fix.md", networkMode: "providerOnly"
  });
}

function fakeRunner(): TaskCommandRunner {
  const task = manifest();
  return {
    start: vi.fn(async () => task), list: vi.fn(() => [task]), show: vi.fn(() => task),
    resume: vi.fn(async (_id, approve) => {
      if (approve) { transitionTask(task, "planning"); transitionTask(task, "awaitingApproval"); transitionTask(task, "implementing"); }
      return task;
    }),
    verify: vi.fn(async () => ({ profile: "p", success: true, startedAt: "a", completedAt: "b", commands: [] })),
    review: vi.fn(async () => ({ artifactPath: "/artifact", report: "review" })),
    remove: vi.fn(async (_id, yes) => { if (!yes) throw new TaskStateConflictError("requires --yes"); })
  };
}

describe("task CLI", () => {
  it("starts planning interactively without storing the prompt in the manifest", async () => {
    const runner = fakeRunner();
    const result = await runTaskCommand(["start", "fix", "login"], {
      cwd: "/source", networkMode: "providerOnly", runner
    });
    expect(result.exitCode).toBe(0);
    expect(result.launch).toMatchObject({ cwd: "/worktree", planning: true });
    expect(result.launch?.initialPrompt).toContain("docs/plans/2026-08-19-fix.md");
    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ name: "fix login" }));
  });

  it("requires explicit --approve-plan to launch implementation", async () => {
    const runner = fakeRunner();
    const result = await runTaskCommand(["resume", "task-1", "--approve-plan"], {
      cwd: "/source", networkMode: "providerOnly", runner
    });
    expect(runner.resume).toHaveBeenCalledWith("task-1", true);
    expect(result.launch?.initialPrompt).toContain("explicitly approved");
  });

  it("does not launch a task that is awaiting approval without the flag", async () => {
    const runner = fakeRunner();
    const task = runner.show("task-1");
    transitionTask(task, "planning");
    transitionTask(task, "awaitingApproval");
    const result = await runTaskCommand(["resume", "task-1"], {
      cwd: "/source", networkMode: "providerOnly", runner
    });
    expect(result.exitCode).toBe(6);
    expect(result.launch).toBeUndefined();
    expect(result.stderr).toContain("--approve-plan");
  });

  it("uses stable exit codes for verification and invalid removal", async () => {
    const runner = fakeRunner();
    vi.mocked(runner.verify).mockResolvedValueOnce({
      profile: "p", success: false, startedAt: "a", completedAt: "b", commands: []
    });
    expect((await runTaskCommand(["verify", "task-1"], {
      cwd: "/source", networkMode: "providerOnly", runner
    })).exitCode).toBe(5);
    expect((await runTaskCommand(["remove", "task-1"], {
      cwd: "/source", networkMode: "providerOnly", runner
    })).exitCode).toBe(6);
  });

  it("launches read-only workers without mutation or MCP tools", async () => {
    const child = newTaskManifest({
      taskId: "worker-1", repositoryId: "repo", sourcePath: "/source", commonDir: "/source/.git",
      worktreePath: "/worker", baseCommit: "abc", branch: "cloudcode/task/worker",
      planPath: "docs/plans/worker.md", networkMode: "providerOnly", parentTaskId: "parent", workerRole: "review"
    });
    const coordinator = { addWorker: vi.fn(async () => ({
      manifest: child, initialPrompt: "review", reference: {
        taskId: child.taskId, role: "review", state: child.state, branch: child.branch,
        worktreePath: child.worktreePath, ownedPaths: [], provider: "local", model: "m", eventLogPath: "/events"
      }
    })) } as unknown as TaskCoordinator;
    const result = await runTaskCommand(["worker", "start", "parent", "review", "--target", "worker-impl"], {
      cwd: "/source", networkMode: "providerOnly", runner: fakeRunner(), coordinator, provider: "local", model: "m"
    });
    expect(result.launch).toMatchObject({ disableMcp: true, toolAllowlist: expect.arrayContaining(["Read", "Diagnostics"]) });
    expect(result.launch?.toolAllowlist).not.toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("previews integration unless --yes explicitly applies it", async () => {
    const integrate = vi.fn(async (_parent: string, _child: string, _yes: boolean) => ({
      parentTaskId: "parent", childTaskId: "child", parentHead: "a", childHead: "b",
      commits: ["b"], changedFiles: ["src/a.ts"], ownershipViolations: [], conflicts: false
    }));
    const integration = { integrate } as unknown as TaskIntegration;
    const result = await runTaskCommand(["integrate", "parent", "child"], {
      cwd: "/source", networkMode: "providerOnly", runner: fakeRunner(), integration
    });
    expect(result.stdout).toContain('"applied": false');
    expect(integrate).toHaveBeenCalledWith("parent", "child", false);
  });
});
