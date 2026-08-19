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
import { resolvePackContributions } from "./packs.js";

export class TaskStateConflictError extends Error {
  readonly code = "TASK_STATE_CONFLICT";
  constructor(message: string) { super(message); this.name = "TaskStateConflictError"; }
}

export class TaskTrustError extends Error {
  readonly code = "TASK_TRUST_DENIED";
  constructor(message: string) { super(message); this.name = "TaskTrustError"; }
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
    const contributions = resolvePackContributions(identity.worktreePath, this.configBase);
    if (contributions.warnings.length) throw new TaskStateConflictError(contributions.warnings.join("\n"));
    const manifest = newTaskManifest({
      taskId, ...identity, planPath: `docs/plans/${date}-${slug(input.name)}.md`,
      networkMode: input.networkMode ?? "providerOnly",
      packs: contributions.packs.map(({ pack }) => ({
        name: pack.manifest.name, version: pack.manifest.version, digest: pack.digest
      })),
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
    const contributions = resolvePackContributions(manifest.worktreePath, this.configBase);
    const currentPacks = contributions.packs.map(({ pack }) => ({
      name: pack.manifest.name, version: pack.manifest.version, digest: pack.digest
    }));
    if (contributions.warnings.length || JSON.stringify(currentPacks) !== JSON.stringify(manifest.packs)) {
      throw new TaskStateConflictError([
        ...contributions.warnings,
        ...(JSON.stringify(currentPacks) !== JSON.stringify(manifest.packs) ? ["Enabled workflow packs changed since task creation."] : [])
      ].join("\n"));
    }
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
    const descriptor = inspectProjectExecutableConfig(manifest.worktreePath, this.configBase);
    if (descriptor && !this.trustStore.isTrusted(descriptor)) {
      if (!input.trustProjectConfig) throw new TaskTrustError("Project verification commands are not trusted.");
      this.trustStore.approve(descriptor);
    }
    const loaded = loadVerificationProfiles(manifest.worktreePath);
    if (loaded.warnings.length) throw new TaskStateConflictError(loaded.warnings.join("\n"));
    const contributions = resolvePackContributions(manifest.worktreePath, this.configBase);
    if (contributions.warnings.length) throw new TaskStateConflictError(contributions.warnings.join("\n"));
    const profiles = [...loaded.profiles];
    for (const profile of contributions.validations) {
      if (profiles.some(item => item.name === profile.name)) {
        throw new TaskStateConflictError(`Verification profile collision: ${profile.name}.`);
      }
      profiles.push(profile);
    }
    const profileName = input.profile ?? manifest.verificationProfile;
    const profile = profiles.find(item => item.name === profileName);
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
    const names = await this.git(["diff", "--name-only", `${manifest.baseCommit}...HEAD`, "--"], manifest.worktreePath);
    const changedFiles = names.code === 0 ? names.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
    const report = [
      `# Task ${manifest.taskId} review`, "", `Base: ${manifest.baseCommit}`, `Branch: ${manifest.branch}`,
      `Worktree: ${manifest.worktreePath}`, `Plan: ${manifest.planPath}`, "", "## Changed files", "",
      changedFiles.length ? changedFiles.map(path => `- ${path}`).join("\n") : "No committed file changes.", "",
      "## Validation evidence", "",
      manifest.artifactPaths.length ? manifest.artifactPaths.map(path => `- ${path}`).join("\n") : "No verification artifact recorded.", "",
      "## Review findings", "", snapshot.truncated ? "- Diff evidence was truncated." : "- Diff evidence was complete.",
      snapshot.status ? "- The worktree has local changes; inspect Status below." : "- The worktree was clean.", "",
      "## Known limitations", "", "- This is a local PR-ready summary; no Git host was contacted.",
      "- Semantic findings require an explicit agent review turn; this artifact records deterministic Git evidence.", "",
      "## Status", "", snapshot.status || "clean", "", "## Diff", "", snapshot.diff || "No changes."
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
    try { await removeTaskWorktree({ manifest, yes, worktreesBase: this.worktreesBase, runner: this.git }); }
    catch (err) { throw new TaskStateConflictError(err instanceof Error ? err.message : String(err)); }
    const owned = taskDir(taskId, this.configBase);
    if (!inside(owned, join(this.configBase, "tasks"))) throw new Error("Task manifest path escaped the task root.");
    rmSync(owned, { recursive: true, force: false });
  }
}
