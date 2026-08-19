import { parseArgs } from "node:util";
import type { TaskManifest } from "../../agent/taskManifest.js";
import { TaskRunner, TaskStateConflictError, TaskTrustError } from "../../agent/taskRunner.js";
import type { NetworkMode } from "../../agent/networkPolicy.js";
import { EXIT_CODES } from "../../print/exitCodes.js";

export interface TaskLaunch {
  taskId: string;
  cwd: string;
  resume?: string;
  networkMode: Exclude<NetworkMode, "unrestricted">;
  initialPrompt?: string;
  planning: boolean;
}

export interface TaskCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  launch?: TaskLaunch;
}

export interface TaskCommandRunner {
  start(input: Parameters<TaskRunner["start"]>[0]): ReturnType<TaskRunner["start"]>;
  list(): TaskManifest[];
  show(taskId: string): TaskManifest;
  resume(taskId: string, approvePlan?: boolean): ReturnType<TaskRunner["resume"]>;
  verify(taskId: string, input?: Parameters<TaskRunner["verify"]>[1]): ReturnType<TaskRunner["verify"]>;
  review(taskId: string): ReturnType<TaskRunner["review"]>;
  remove(taskId: string, yes: boolean): ReturnType<TaskRunner["remove"]>;
}

const USAGE = [
  "Usage:",
  "  cloudcode task start <description>",
  "  cloudcode task list",
  "  cloudcode task show <task-id>",
  "  cloudcode task resume <task-id> [--approve-plan]",
  "  cloudcode task verify <task-id> [--profile <name>] [--trust-project-config]",
  "  cloudcode task review <task-id>",
  "  cloudcode task remove <task-id> --yes"
].join("\n");

function launchFor(manifest: TaskManifest, initialPrompt: string | undefined, planning: boolean): TaskLaunch {
  return {
    taskId: manifest.taskId, cwd: manifest.worktreePath, resume: manifest.sessionId,
    networkMode: manifest.networkMode, ...(initialPrompt ? { initialPrompt } : {}), planning
  };
}

function display(manifest: TaskManifest): string {
  return [
    `Task: ${manifest.taskId}`, `State: ${manifest.state}`, `Branch: ${manifest.branch}`,
    `Base: ${manifest.baseCommit}`, `Worktree: ${manifest.worktreePath}`, `Plan: ${manifest.planPath}`,
    `Session: ${manifest.sessionId ?? "(not started)"}`
  ].join("\n");
}

export async function runTaskCommand(args: string[], options: {
  cwd: string;
  networkMode: Exclude<NetworkMode, "unrestricted">;
  runner?: TaskCommandRunner;
}): Promise<TaskCliResult> {
  const runner = options.runner ?? new TaskRunner();
  const [command, ...rest] = args;
  try {
    if (command === "start") {
      if (!rest.length || rest.some(arg => arg.startsWith("--"))) return { exitCode: 2, stderr: USAGE };
      const description = rest.join(" ").trim();
      const manifest = await runner.start({ cwd: options.cwd, name: description, networkMode: options.networkMode });
      const prompt = [
        `Work on this isolated task: ${description}`,
        "Research the repository and read every applicable AGENTS.md before deciding validation commands.",
        `Write the implementation plan to ${manifest.planPath}.`,
        "Do not implement the plan in this turn. Stop after the plan is complete and wait for explicit approval."
      ].join("\n");
      return { exitCode: 0, stdout: display(manifest), launch: launchFor(manifest, prompt, true) };
    }
    if (command === "list") {
      if (rest.length) return { exitCode: 2, stderr: USAGE };
      const tasks = runner.list();
      return { exitCode: 0, stdout: tasks.length
        ? tasks.map(task => `${task.taskId}  ${task.state}  ${task.branch}  ${task.worktreePath}`).join("\n")
        : "No local tasks." };
    }
    if (command === "show") {
      if (rest.length !== 1) return { exitCode: 2, stderr: USAGE };
      return { exitCode: 0, stdout: JSON.stringify(runner.show(rest[0]), null, 2) };
    }
    if (command === "resume") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { "approve-plan": { type: "boolean", default: false } }
      });
      if (positionals.length !== 1) return { exitCode: 2, stderr: USAGE };
      const manifest = await runner.resume(positionals[0], values["approve-plan"]);
      if (manifest.state === "awaitingApproval" && !values["approve-plan"]) {
        return {
          exitCode: EXIT_CODES.taskConflict,
          stderr: `Task ${manifest.taskId} is awaiting plan approval. Re-run with --approve-plan to begin implementation.`
        };
      }
      const prompt = values["approve-plan"]
        ? `The plan at ${manifest.planPath} is explicitly approved. Implement it now, then run its focused validation.`
        : undefined;
      return { exitCode: 0, stdout: display(manifest), launch: launchFor(manifest, prompt, false) };
    }
    if (command === "verify") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { profile: { type: "string" }, "trust-project-config": { type: "boolean", default: false } }
      });
      if (positionals.length !== 1) return { exitCode: 2, stderr: USAGE };
      const result = await runner.verify(positionals[0], {
        profile: values.profile, trustProjectConfig: values["trust-project-config"]
      });
      return { exitCode: result.success ? 0 : EXIT_CODES.verificationFailed, stdout: JSON.stringify(result, null, 2) };
    }
    if (command === "review") {
      if (rest.length !== 1) return { exitCode: 2, stderr: USAGE };
      const result = await runner.review(rest[0]);
      return { exitCode: 0, stdout: `${result.report}\n\nSaved: ${result.artifactPath}` };
    }
    if (command === "remove") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { yes: { type: "boolean", default: false } }
      });
      if (positionals.length !== 1) return { exitCode: 2, stderr: USAGE };
      await runner.remove(positionals[0], values.yes);
      return { exitCode: 0, stdout: `Removed local task ${positionals[0]}. Its worktree, branch, manifest, and artifacts are no longer recoverable from cloudcode.` };
    }
    return { exitCode: 2, stderr: USAGE };
  } catch (err) {
    return {
      exitCode: err instanceof TaskTrustError ? EXIT_CODES.permissionDenied
        : err instanceof TaskStateConflictError ? EXIT_CODES.taskConflict : EXIT_CODES.executionError,
      stderr: err instanceof Error ? err.message : String(err)
    };
  }
}
