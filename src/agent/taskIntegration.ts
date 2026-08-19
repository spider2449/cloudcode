import { configDir } from "./providers.js";
import { loadTaskManifest, saveTaskManifest, transitionTask, type TaskChildReference, type TaskManifest } from "./taskManifest.js";
import { TaskStateConflictError } from "./taskRunner.js";
import { runGit, validateTaskWorktree, type GitRunner } from "./worktree.js";

export interface IntegrationPreview {
  parentTaskId: string;
  childTaskId: string;
  parentHead: string;
  childHead: string;
  commits: string[];
  changedFiles: string[];
  ownershipViolations: string[];
  conflicts: boolean;
  conflictEvidence?: string;
}

function within(path: string, owner: string): boolean {
  const value = path.replaceAll("\\", "/").toLowerCase();
  const root = owner.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  return value === root || value.startsWith(`${root}/`);
}

async function required(git: GitRunner, args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0 || result.truncated) {
    throw new TaskStateConflictError(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

function childReference(parent: TaskManifest, childId: string): TaskChildReference {
  const child = parent.children.find(item => item.taskId === childId);
  if (!child) throw new TaskStateConflictError(`Task ${childId} is not a child of ${parent.taskId}.`);
  if (child.role !== "implement") throw new TaskStateConflictError(`Only implementation workers can be integrated; ${child.role} output is an artifact.`);
  return child;
}

export class TaskIntegration {
  constructor(private options: { configBase?: string; git?: GitRunner } = {}) {}

  private manifests(parentId: string, childId: string): { parent: TaskManifest; child: TaskManifest; reference: TaskChildReference } {
    const base = this.options.configBase ?? configDir();
    const parent = loadTaskManifest(parentId, base);
    const child = loadTaskManifest(childId, base);
    const reference = childReference(parent, childId);
    if (child.parentTaskId !== parentId) throw new TaskStateConflictError("Child manifest parent identity mismatch.");
    if (child.baseCommit !== parent.baseCommit || child.repositoryId !== parent.repositoryId) {
      throw new TaskStateConflictError("Parent and child do not share the recorded base repository state.");
    }
    return { parent, child, reference };
  }

  async preview(parentId: string, childId: string): Promise<IntegrationPreview> {
    const git = this.options.git ?? runGit;
    const { parent, child, reference } = this.manifests(parentId, childId);
    const parentState = await validateTaskWorktree(parent, git);
    const childState = await validateTaskWorktree(child, git);
    if (!parentState.clean) throw new TaskStateConflictError("Parent task worktree must be clean before integration preview.");
    if (!childState.clean) throw new TaskStateConflictError("Worker worktree must be clean and committed before integration preview.");
    const commitsText = await required(git, ["rev-list", "--reverse", `${child.baseCommit}..${childState.head}`], child.worktreePath);
    const commits = commitsText.split(/\r?\n/).filter(Boolean);
    if (!commits.length) throw new TaskStateConflictError("Worker has no commits to integrate.");
    const filesText = await required(git, ["diff", "--name-only", `${child.baseCommit}...${childState.head}`, "--"], child.worktreePath);
    const changedFiles = filesText.split(/\r?\n/).filter(Boolean);
    const ownershipViolations = changedFiles.filter(path => path !== child.planPath && !reference.ownedPaths.some(owner => within(path, owner)));
    let merge = await git(["merge-tree", "--write-tree", parentState.head, childState.head], parent.worktreePath);
    if (merge.code !== 0 && /unknown option|usage:/i.test(merge.stderr || merge.stdout)) {
      merge = await git(["merge-tree", child.baseCommit, parentState.head, childState.head], parent.worktreePath);
      const evidence = `${merge.stdout}\n${merge.stderr}`;
      const conflicts = /<<<<<<<|>>>>>>>|changed in both/i.test(evidence);
      return {
        parentTaskId: parentId, childTaskId: childId, parentHead: parentState.head, childHead: childState.head,
        commits, changedFiles, ownershipViolations, conflicts,
        ...(conflicts ? { conflictEvidence: evidence.slice(0, 16_384) } : {})
      };
    }
    const evidence = `${merge.stdout}\n${merge.stderr}`;
    return {
      parentTaskId: parentId, childTaskId: childId, parentHead: parentState.head, childHead: childState.head,
      commits, changedFiles, ownershipViolations, conflicts: merge.code !== 0,
      ...(merge.code !== 0 ? { conflictEvidence: evidence.slice(0, 16_384) } : {})
    };
  }

  async integrate(parentId: string, childId: string, yes: boolean): Promise<IntegrationPreview> {
    const preview = await this.preview(parentId, childId);
    if (!yes) return preview;
    if (preview.conflicts) throw new TaskStateConflictError("Integration preview found conflicts; worker branches and worktrees were retained.");
    if (preview.ownershipViolations.length) {
      throw new TaskStateConflictError(`Worker changed paths outside its ownership: ${preview.ownershipViolations.join(", ")}.`);
    }
    const git = this.options.git ?? runGit;
    const { parent, reference } = this.manifests(parentId, childId);
    const result = await git(["cherry-pick", ...preview.commits], parent.worktreePath);
    if (result.code !== 0) {
      throw new TaskStateConflictError(`Integration failed and all worker state was retained: ${(result.stderr || result.stdout).trim()}`);
    }
    reference.recordedHead = preview.childHead;
    reference.state = "completed";
    const base = this.options.configBase ?? configDir();
    const child = loadTaskManifest(childId, base);
    if (child.state === "reviewReady") transitionTask(child, "completed", `integrated into parent ${parentId}`);
    saveTaskManifest(child, base);
    parent.coordinatorState = parent.children.every(item => item.state === "completed") ? "completed" : "awaitingIntegration";
    saveTaskManifest(parent, base);
    return preview;
  }
}
