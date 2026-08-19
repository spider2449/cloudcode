import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { configDir } from "./providers.js";
import { collectGitReviewAgainstBase } from "./gitReview.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "./projectTrust.js";
import {
  listTaskManifests, loadTaskManifest, newTaskManifest, saveTaskManifest, taskDir,
  transitionTask, type TaskManifest
} from "./taskManifest.js";
import { createTaskWorktree, removeTaskWorktree, runGit, validateTaskWorktree, type GitRunner } from "./worktree.js";
import { loadVerificationProfiles, runVerification, type VerificationResult } from "./taskVerification.js";
import type { NetworkMode } from "./networkPolicy.js";
import type { RunLimits } from "../engine/runLimits.js";

export class TaskStateConflictError extends Error {
  readonly code = "TASK_STATE_CONFLICT";
  constructor(message: string) { super(message); this.name = "TaskStateConflictError"; }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function inside(path: string, root: string): boolean {
  const child = resolve(path).toLowerCase();
  const parent = resolve(root).toLowerCase();
  return child === parent || child.startsWith(parent + sep);
}

export interface TaskRunnerOptions {
  configBase?: string;
  worktreesBase?: string;
  git?: GitRunner;
  trustStore?: ProjectTrustStore;
}

export class TaskRunner {
  private configBase: string;
  private worktreesBase: string;
  private git: GitRunner;
  private trustStore: ProjectTrustStore;

  constructor(options: TaskRunnerOptions = {}) {
    this.configBase = options.configBase ?? configDir();
    this.worktreesBase = options.worktreesBase ?? join(this.configBase, "worktrees");
    this.git = options.git ?? runGit;
    this.trustStore = options.trustStore ?? new ProjectTrustStore(join(this.configBase, "trusted-project-configs.json"));
  }

  async start(input: {
    cwd: string; name: string; base?: string; networkMode?: Exclude<NetworkMode, "unrestricted">;
    limits?: RunLimits; verificationProfile?: string; now?: Date;
  }): Promise<TaskManifest> {
    const taskId = randomUUID();
    const identity = await createTaskWorktree({
      cwd: input.cwd, taskId, name: input.name, base: input.base,
      worktreesBase: this.worktreesBase, runner: this.git
    });
    const date = (input.now ?? new Date()).toISOString().slice(0, 10);
    const manifest = newTaskManifest({
      taskId, ...identity, planPath: `docs/plans/${date}-${slug(input.name)}.md`,
      networkMode: input.networkMode ?? "providerOnly",
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.verificationProfile ? { verificationProfile: input.verificationProfile } : {})
    }, input.now);
    transitionTask(manifest, "planning", "isolated worktree created", input.now);
    saveTaskManifest(manifest, this.configBase);
    return manifest;
  }

  list(): TaskManifest[] { return listTaskManifests(this.configBase); }
  show(taskId: string): TaskManifest { return loadTaskManifest(taskId, this.configBase); }

  async resume(taskId: string, approvePlan = false): Promise<TaskManifest> {
    const manifest = this.show(taskId);
    try { await validateTaskWorktree(manifest, this.git); }
    catch (err) { throw new TaskStateConflictError(err instanceof Error ? err.message : String(err)); }
    if (approvePlan) {
      if (manifest.state !== "awaitingApproval") {
        throw new TaskStateConflictError(`Task ${taskId} is ${manifest.state}, not awaitingApproval.`);
      }
      if (!existsSync(join(manifest.worktreePath, manifest.planPath))) {
        throw new TaskStateConflictError(`Approved plan is missing: ${manifest.planPath}`);
      }
      transitionTask(manifest, "implementing", "plan explicitly approved");
      saveTaskManifest(manifest, this.configBase);
    }
    return manifest;
  }

  markPlanReady(taskId: string, sessionId?: string): TaskManifest {
    const manifest = this.show(taskId);
    if (!existsSync(join(manifest.worktreePath, manifest.planPath))) {
      throw new TaskStateConflictError(`Planning turn did not create ${manifest.planPath}.`);
    }
    if (sessionId) manifest.sessionId = sessionId;
    transitionTask(manifest, "awaitingApproval", "plan written; explicit approval required");
    saveTaskManifest(manifest, this.configBase);
    return manifest;
  }

  recordSession(taskId: string, sessionId: string): void {
    const manifest = this.show(taskId);
    manifest.sessionId = sessionId;
    saveTaskManifest(manifest, this.configBase);
  }

  async verify(taskId: string, input: {
    profile?: string; trustProjectConfig?: boolean; signal?: AbortSignal;
  } = {}): Promise<VerificationResult> {
    const manifest = await this.resume(taskId);
    const descriptor = inspectProjectExecutableConfig(manifest.worktreePath);
    if (descriptor && !this.trustStore.isTrusted(descriptor)) {
      if (!input.trustProjectConfig) throw new TaskStateConflictError("Project verification commands are not trusted.");
      this.trustStore.approve(descriptor);
    }
    const loaded = loadVerificationProfiles(manifest.worktreePath);
    if (loaded.warnings.length) throw new TaskStateConflictError(loaded.warnings.join("\n"));
    const profileName = input.profile ?? manifest.verificationProfile;
    const profile = loaded.profiles.find(item => item.name === profileName);
    if (!profile) throw new TaskStateConflictError(`Verification profile not found: ${profileName ?? "(none selected)"}.`);
    if (manifest.state !== "implementing" && manifest.state !== "reviewReady") {
      throw new TaskStateConflictError(`Task ${taskId} cannot verify from state ${manifest.state}.`);
    }
    transitionTask(manifest, "verifying");
    saveTaskManifest(manifest, this.configBase);
    const result = await runVerification({ cwd: manifest.worktreePath, profile, signal: input.signal });
    const artifact = join(taskDir(taskId, this.configBase), "artifacts", `verification-${Date.now()}.json`);
    atomicWrite(artifact, JSON.stringify(result, null, 2) + "\n");
    manifest.artifactPaths.push(artifact);
    transitionTask(manifest, result.success ? "reviewReady" : "failed", result.success ? "verification passed" : "verification failed");
    saveTaskManifest(manifest, this.configBase);
    return result;
  }

  async review(taskId: string): Promise<{ artifactPath: string; report: string }> {
    const manifest = await this.resume(taskId);
    const snapshot = await collectGitReviewAgainstBase(manifest.worktreePath, manifest.baseCommit, this.git);
    if (!snapshot.isGitRepo || snapshot.error) throw new TaskStateConflictError(snapshot.error ?? "Task review failed.");
    const report = [
      `# Task ${manifest.taskId} review`, "", `Base: ${manifest.baseCommit}`, `Branch: ${manifest.branch}`,
      `Worktree: ${manifest.worktreePath}`, "", "## Status", "", snapshot.status || "clean", "",
      "## Diff", "", snapshot.diff || "No changes.", "", snapshot.truncated ? "Diff was truncated." : "Diff was complete."
    ].join("\n");
    const artifactPath = join(taskDir(taskId, this.configBase), "artifacts", `review-${Date.now()}.md`);
    atomicWrite(artifactPath, report + "\n");
    manifest.artifactPaths.push(artifactPath);
    if (manifest.state === "implementing" || manifest.state === "verifying") transitionTask(manifest, "reviewReady", "local review artifact created");
    saveTaskManifest(manifest, this.configBase);
    return { artifactPath, report };
  }

  async remove(taskId: string, yes: boolean): Promise<void> {
    const manifest = this.show(taskId);
    await removeTaskWorktree({ manifest, yes, worktreesBase: this.worktreesBase, runner: this.git });
    const owned = taskDir(taskId, this.configBase);
    if (!inside(owned, join(this.configBase, "tasks"))) throw new Error("Task manifest path escaped the task root.");
    rmSync(owned, { recursive: true, force: false });
  }
}
