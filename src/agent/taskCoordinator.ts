import { isAbsolute, normalize, sep } from "node:path";
import { configDir } from "./providers.js";
import {
  loadTaskManifest, saveTaskManifest, taskDir, type TaskChildReference,
  type TaskManifest, type WorkerRole
} from "./taskManifest.js";
import { TaskRunner, TaskStateConflictError } from "./taskRunner.js";
import type { RunLimits } from "../engine/runLimits.js";
import { runGit, validateTaskWorktree, type GitRunner } from "./worktree.js";

export interface WorkerPlan {
  manifest: TaskManifest;
  reference: TaskChildReference;
  initialPrompt: string;
  warning?: string;
}

function ownedPath(value: string): string {
  const path = normalize(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!path || isAbsolute(value) || path === ".." || path.startsWith("../")) {
    throw new TaskStateConflictError(`Worker path must stay inside the repository: ${value}.`);
  }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function active(child: TaskChildReference): boolean {
  return child.state !== "completed" && child.state !== "failed" && child.state !== "interrupted";
}

function prompt(role: WorkerRole, parent: TaskManifest, paths: string[]): string {
  const scope = paths.length ? `Owned paths: ${paths.join(", ")}.` : "No writable path ownership is assigned.";
  const common = `Parent task: ${parent.taskId}. Base commit: ${parent.baseCommit}. ${scope}`;
  if (role === "research") return `${common}\nResearch read-only evidence and write a concise artifact. Do not modify files or create commits.`;
  if (role === "implement") return `${common}\nImplement only the approved plan within the owned paths, validate, and commit the result locally.`;
  if (role === "verify") return `${common}\nVerify the recorded implementation state read-only and report attributable evidence. Do not modify files.`;
  return `${common}\nReview the recorded diff read-only. Rank findings by severity with exact file references.`;
}

export class TaskCoordinator {
  private base: string;
  private runner: TaskRunner;
  private git: GitRunner;

  constructor(options: { configBase?: string; runner?: TaskRunner; git?: GitRunner } = {}) {
    this.base = options.configBase ?? configDir();
    this.runner = options.runner ?? new TaskRunner({ configBase: this.base });
    this.git = options.git ?? runGit;
  }

  parent(taskId: string): TaskManifest {
    const manifest = loadTaskManifest(taskId, this.base);
    if (manifest.parentTaskId) throw new TaskStateConflictError(`Task ${taskId} is a worker, not a coordinator.`);
    return manifest;
  }

  async addWorker(input: {
    parentTaskId: string; role: WorkerRole; ownedPaths?: string[];
    provider: string; model: string; limits?: RunLimits;
    concurrency?: number; explicitParallel?: boolean;
    targetTaskId?: string;
  }): Promise<WorkerPlan> {
    const parent = this.refresh(input.parentTaskId);
    if (input.role !== "research" && parent.state !== "implementing" && parent.state !== "reviewReady") {
      throw new TaskStateConflictError(`Parent task ${parent.taskId} must have an approved plan before ${input.role} starts.`);
    }
    const concurrency = input.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
      throw new TaskStateConflictError("Worker concurrency must be between 1 and 3.");
    }
    if (concurrency > 1 && !input.explicitParallel) {
      throw new TaskStateConflictError("Parallel workers require an explicit --parallel acknowledgement.");
    }
    if (parent.children.filter(active).length >= concurrency) {
      throw new TaskStateConflictError(`Worker concurrency limit ${concurrency} is already reached.`);
    }
    const prior = parent.children[0];
    if (prior && (prior.provider !== input.provider || prior.model !== input.model)) {
      throw new TaskStateConflictError(`All workers must use ${prior.provider}/${prior.model}.`);
    }
    const paths = [...new Set((input.ownedPaths ?? []).map(ownedPath))];
    if (input.role === "implement") {
      if (!paths.length) throw new TaskStateConflictError("Implementation workers require at least one owned path.");
      for (const child of parent.children.filter(item => item.role === "implement" && active(item))) {
        for (const path of paths) for (const existing of child.ownedPaths) {
          if (overlaps(path, existing)) throw new TaskStateConflictError(`Worker path ownership overlaps ${existing}.`);
        }
      }
    }
    let targetCommit: string | undefined;
    if (input.role === "verify" || input.role === "review") {
      if (!input.targetTaskId) throw new TaskStateConflictError(`${input.role} workers require --target <implementation-worker-id>.`);
      const targetRef = parent.children.find(child => child.taskId === input.targetTaskId && child.role === "implement");
      if (!targetRef) throw new TaskStateConflictError(`Target is not an implementation worker of ${parent.taskId}.`);
      const target = loadTaskManifest(input.targetTaskId, this.base);
      const state = await validateTaskWorktree(target, this.git);
      if (!state.clean) throw new TaskStateConflictError("Verification and review targets must be committed and clean.");
      targetCommit = state.head;
    }
    const child = await this.runner.start({
      cwd: parent.sourcePath, base: targetCommit ?? parent.baseCommit,
      name: `${input.role}-${parent.taskId.slice(0, 8)}`, networkMode: parent.networkMode,
      limits: input.limits, parentTaskId: parent.taskId, workerRole: input.role, ownedPaths: paths
    });
    const reference: TaskChildReference = {
      taskId: child.taskId, role: input.role, state: child.state, branch: child.branch,
      worktreePath: child.worktreePath, ownedPaths: paths, provider: input.provider, model: input.model,
      ...(input.limits ? { limits: input.limits } : {}),
      eventLogPath: `${taskDir(child.taskId, this.base)}${sep}worker-events.jsonl`,
      ...(targetCommit ? { targetCommit } : {})
    };
    parent.children.push(reference);
    parent.coordinatorState = "running";
    saveTaskManifest(parent, this.base);
    return {
      manifest: child, reference, initialPrompt: prompt(input.role, parent, paths),
      ...(concurrency > 1 ? { warning: "Parallel workers may multiply provider cost and expose prompts to the selected non-loopback provider." } : {})
    };
  }

  refresh(taskId: string): TaskManifest {
    const parent = this.parent(taskId);
    for (const child of parent.children) {
      try {
        const manifest = loadTaskManifest(child.taskId, this.base);
        child.state = manifest.state;
      } catch { child.state = "conflicted"; }
    }
    if (parent.coordinatorState !== "cancelled") {
      parent.coordinatorState = parent.children.some(active) ? "running"
        : parent.children.length ? "awaitingIntegration" : "idle";
    }
    saveTaskManifest(parent, this.base);
    return parent;
  }

  cancel(taskId: string): TaskManifest {
    const parent = this.parent(taskId);
    parent.coordinatorState = "cancelled";
    saveTaskManifest(parent, this.base);
    return parent;
  }
}
