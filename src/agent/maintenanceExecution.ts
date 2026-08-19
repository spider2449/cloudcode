import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configDir } from "./providers.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "./projectTrust.js";
import { resolvePackContributions } from "./packs.js";
import { newTaskManifest } from "./taskManifest.js";
import { loadVerificationProfiles, runVerification, type VerificationEvent } from "./taskVerification.js";
import { TaskTrustError, TaskStateConflictError } from "./taskRunner.js";
import { createTaskWorktree, removeTaskWorktree, runGit, type GitRunner } from "./worktree.js";
import type { MaintenanceProfile } from "./maintenanceConfig.js";
import type { MaintenanceRunOutput } from "./maintenanceRuns.js";

export async function runIsolatedMaintenanceVerification(input: {
  cwd: string; profile: MaintenanceProfile; trustProjectConfig: boolean;
  configBase?: string; worktreesBase?: string; trustStore?: ProjectTrustStore;
  git?: GitRunner; signal?: AbortSignal;
}): Promise<MaintenanceRunOutput> {
  if (input.profile.execution !== "isolatedVerification" || !input.profile.validationProfile) {
    throw new TaskStateConflictError(`Maintenance profile ${input.profile.name} requires a validationProfile.`);
  }
  const base = input.configBase ?? configDir();
  const git = input.git ?? runGit;
  const descriptor = inspectProjectExecutableConfig(input.cwd, base);
  const trust = input.trustStore ?? new ProjectTrustStore(join(base, "trusted-project-configs.json"));
  if (descriptor && !trust.isTrusted(descriptor)) {
    if (!input.trustProjectConfig) throw new TaskTrustError("Maintenance validation commands are not trusted.");
    trust.approve(descriptor);
  }
  const taskId = randomUUID();
  const identity = await createTaskWorktree({
    cwd: input.cwd, taskId, name: `maintenance-${input.profile.name}`,
    worktreesBase: input.worktreesBase ?? join(base, "maintenance-worktrees"), runner: git
  });
  const events: VerificationEvent[] = [];
  try {
    const loaded = loadVerificationProfiles(identity.worktreePath);
    const packs = resolvePackContributions(identity.worktreePath, base);
    const warnings = [...loaded.warnings, ...packs.warnings];
    if (warnings.length) throw new TaskStateConflictError(warnings.join("\n"));
    const profiles = [...loaded.profiles, ...packs.validations];
    const profile = profiles.find(item => item.name === input.profile.validationProfile);
    if (!profile) throw new TaskStateConflictError(`Verification profile not found: ${input.profile.validationProfile}.`);
    const result = await runVerification({
      cwd: identity.worktreePath, profile, signal: input.signal, onEvent: event => events.push(event)
    });
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], identity.worktreePath);
    const dirty = status.code !== 0 || status.stdout.trim() !== "";
    let retained = dirty;
    if (!dirty) {
      try {
        const manifest = newTaskManifest({ ...identity, planPath: "", networkMode: input.profile.networkMode });
        await removeTaskWorktree({
          manifest, yes: true, worktreesBase: input.worktreesBase ?? join(base, "maintenance-worktrees"), runner: git
        });
      } catch { retained = true; }
    }
    const report = [
      `# Maintenance verification: ${input.profile.name}`, "",
      `Profile: ${result.profile}`, `Success: ${result.success}`, `Worktree retained: ${retained}`,
      ...(retained ? [`Worktree: ${identity.worktreePath}`] : []), "", "## Commands", "",
      ...result.commands.map(command => `- ${command.command} ${command.args.join(" ")} (exit ${command.code})`)
    ].join("\n") + "\n";
    return {
      exitCode: result.success ? 0 : 5, report,
      events: events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "")
    };
  } catch (err) {
    // A failed setup may contain useful local state; leave the owned worktree
    // intact instead of risking evidence loss.
    throw err;
  }
}
