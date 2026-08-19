import { parseArgs } from "node:util";
import type { TaskManifest } from "../../agent/taskManifest.js";
import { TaskRunner, TaskStateConflictError, TaskTrustError } from "../../agent/taskRunner.js";
import type { NetworkMode } from "../../agent/networkPolicy.js";
import { EXIT_CODES } from "../../print/exitCodes.js";
import { TaskCoordinator } from "../../agent/taskCoordinator.js";
import { TaskIntegration } from "../../agent/taskIntegration.js";
import type { WorkerRole } from "../../agent/taskManifest.js";

export interface TaskLaunch {
  taskId: string;
  cwd: string;
  resume?: string;
  networkMode: Exclude<NetworkMode, "unrestricted">;
  initialPrompt?: string;
  planning: boolean;
  toolAllowlist?: readonly string[];
  disableMcp?: boolean;
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
  "  cloudcode task remove <task-id> --yes",
  "  cloudcode task worker start <parent-id> <research|implement|verify|review> [--paths <a,b>] [--target <worker-id>] [--concurrency 1..3 --parallel]",
  "  cloudcode task workers <parent-id>",
  "  cloudcode task integrate <parent-id> <worker-id> [--yes]",
  "  cloudcode task cancel-workers <parent-id>"
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
  provider?: string;
  model?: string;
  coordinator?: TaskCoordinator;
  integration?: TaskIntegration;
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
    if (command === "workers") {
      if (rest.length !== 1) return { exitCode: 2, stderr: USAGE };
      const parent = (options.coordinator ?? new TaskCoordinator()).refresh(rest[0]);
      return { exitCode: 0, stdout: parent.children.length ? parent.children.map(child =>
        `${child.taskId}  ${child.role}  ${child.state}  ${child.provider}/${child.model}  ${child.ownedPaths.join(",") || "read-only"}`
      ).join("\n") : "No workers for this task." };
    }
    if (command === "worker" && rest[0] === "start") {
      const { values, positionals } = parseArgs({
        args: rest.slice(1), allowPositionals: true,
        options: {
          paths: { type: "string" }, provider: { type: "string" }, model: { type: "string" },
          target: { type: "string" },
          concurrency: { type: "string", default: "1" }, parallel: { type: "boolean", default: false },
          "max-turns": { type: "string" }
        }
      });
      const role = positionals[1] as WorkerRole | undefined;
      if (positionals.length !== 2 || !role || !["research", "implement", "verify", "review"].includes(role)) {
        return { exitCode: 2, stderr: USAGE };
      }
      const concurrency = Number(values.concurrency);
      const maxTurns = values["max-turns"] === undefined ? undefined : Number(values["max-turns"]);
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1))) {
        return { exitCode: 2, stderr: "--concurrency and --max-turns must be positive integers." };
      }
      const plan = await (options.coordinator ?? new TaskCoordinator()).addWorker({
        parentTaskId: positionals[0], role,
        ownedPaths: values.paths?.split(",").map(path => path.trim()).filter(Boolean),
        provider: values.provider ?? options.provider ?? "anthropic",
        model: values.model ?? options.model ?? "default", concurrency,
        explicitParallel: values.parallel, targetTaskId: values.target,
        ...(maxTurns ? { limits: { maxTurns } } : {})
      });
      const readOnly = role !== "implement";
      return {
        exitCode: 0,
        stdout: [display(plan.manifest), ...(plan.warning ? [`Warning: ${plan.warning}`] : [])].join("\n"),
        launch: {
          ...launchFor(plan.manifest, plan.initialPrompt, true),
          ...(readOnly ? {
            toolAllowlist: ["Read", "Glob", "Grep", "Definition", "References", "Hover", "Symbols", "Diagnostics"],
            disableMcp: true
          } : {})
        }
      };
    }
    if (command === "integrate") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { yes: { type: "boolean", default: false } }
      });
      if (positionals.length !== 2) return { exitCode: 2, stderr: USAGE };
      const preview = await (options.integration ?? new TaskIntegration()).integrate(positionals[0], positionals[1], values.yes);
      return { exitCode: 0, stdout: JSON.stringify({ applied: values.yes, ...preview }, null, 2) };
    }
    if (command === "cancel-workers") {
      if (rest.length !== 1) return { exitCode: 2, stderr: USAGE };
      const parent = (options.coordinator ?? new TaskCoordinator()).cancel(rest[0]);
      return { exitCode: 0, stdout: `Coordinator ${parent.taskId} marked cancelled. Active scheduler workers will receive cancellation.` };
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
