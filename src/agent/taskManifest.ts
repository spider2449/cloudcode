import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import type { NetworkMode } from "./networkPolicy.js";
import type { RunLimits } from "../engine/runLimits.js";

export type TaskState =
  | "created" | "planning" | "awaitingApproval" | "implementing" | "verifying"
  | "reviewReady" | "completed" | "failed" | "interrupted" | "conflicted";

export interface TaskTransition {
  state: TaskState;
  timestamp: string;
  note?: string;
}

export interface TaskPackIdentity {
  name: string;
  version: string;
  digest: string;
}

export type WorkerRole = "research" | "implement" | "verify" | "review";
export type CoordinatorState = "idle" | "running" | "awaitingIntegration" | "completed" | "cancelled";

export interface TaskChildReference {
  taskId: string;
  role: WorkerRole;
  state: TaskState;
  branch: string;
  worktreePath: string;
  ownedPaths: string[];
  provider: string;
  model: string;
  limits?: RunLimits;
  eventLogPath: string;
  recordedHead?: string;
  targetCommit?: string;
  sessionId?: string;
}

export interface TaskManifest {
  version: 2;
  taskId: string;
  repositoryId: string;
  sourcePath: string;
  commonDir: string;
  worktreePath: string;
  baseCommit: string;
  branch: string;
  sessionId?: string;
  state: TaskState;
  transitions: TaskTransition[];
  planPath: string;
  verificationProfile?: string;
  networkMode: Exclude<NetworkMode, "unrestricted">;
  limits?: RunLimits;
  packs: TaskPackIdentity[];
  parentTaskId?: string;
  workerRole?: WorkerRole;
  ownedPaths: string[];
  coordinatorState: CoordinatorState;
  children: TaskChildReference[];
  artifactPaths: string[];
}

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  created: ["planning", "failed", "interrupted"],
  planning: ["awaitingApproval", "failed", "interrupted"],
  awaitingApproval: ["implementing", "failed", "interrupted"],
  implementing: ["verifying", "reviewReady", "failed", "interrupted", "conflicted"],
  verifying: ["reviewReady", "failed", "interrupted", "conflicted"],
  reviewReady: ["completed", "implementing", "verifying", "failed", "conflicted"],
  completed: [], failed: ["planning", "implementing", "verifying"],
  interrupted: ["planning", "implementing", "verifying"],
  conflicted: ["implementing", "failed"]
};

export function tasksDir(base: string = configDir()): string { return join(base, "tasks"); }
export function taskDir(taskId: string, base: string = configDir()): string { return join(tasksDir(base), taskId); }
export function taskManifestPath(taskId: string, base: string = configDir()): string {
  return join(taskDir(taskId, base), "manifest.json");
}

function isState(value: unknown): value is TaskState {
  return typeof value === "string" && Object.hasOwn(TRANSITIONS, value);
}

function isWorkerRole(value: unknown): value is WorkerRole {
  return value === "research" || value === "implement" || value === "verify" || value === "review";
}

function isChild(value: unknown): value is TaskChildReference {
  if (!value || typeof value !== "object") return false;
  const child = value as Partial<TaskChildReference>;
  return typeof child.taskId === "string" && isWorkerRole(child.role) && isState(child.state) &&
    typeof child.branch === "string" && typeof child.worktreePath === "string" && Array.isArray(child.ownedPaths) &&
    child.ownedPaths.every(path => typeof path === "string") && typeof child.provider === "string" &&
    typeof child.model === "string" && typeof child.eventLogPath === "string" &&
    (child.targetCommit === undefined || typeof child.targetCommit === "string") &&
    (child.sessionId === undefined || typeof child.sessionId === "string");
}

function isManifest(value: unknown): value is Omit<TaskManifest, "version" | "ownedPaths" | "coordinatorState" | "children"> & {
  version: 1 | 2; ownedPaths?: string[]; coordinatorState?: CoordinatorState; children?: TaskChildReference[];
} {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Omit<TaskManifest, "version">> & { version?: 1 | 2 };
  const coordinatorValid = item.version === 1 || (
    Array.isArray(item.ownedPaths) && item.ownedPaths.every(path => typeof path === "string") &&
    (item.coordinatorState === "idle" || item.coordinatorState === "running" || item.coordinatorState === "awaitingIntegration" ||
      item.coordinatorState === "completed" || item.coordinatorState === "cancelled") &&
    Array.isArray(item.children) && item.children.every(isChild) &&
    (item.workerRole === undefined || isWorkerRole(item.workerRole))
  );
  return coordinatorValid && typeof item.taskId === "string" && typeof item.repositoryId === "string" &&
    typeof item.sourcePath === "string" && typeof item.commonDir === "string" && typeof item.worktreePath === "string" &&
    typeof item.baseCommit === "string" && typeof item.branch === "string" && isState(item.state) &&
    Array.isArray(item.transitions) && item.transitions.length > 0 && typeof item.planPath === "string" && Array.isArray(item.artifactPaths) &&
    (item.packs === undefined || (Array.isArray(item.packs) && item.packs.every(pack =>
      pack && typeof pack.name === "string" && typeof pack.version === "string" && typeof pack.digest === "string"
    ))) &&
    (item.networkMode === "offlineStrict" || item.networkMode === "providerOnly");
}

export function saveTaskManifest(manifest: TaskManifest, base: string = configDir()): void {
  const path = taskManifestPath(manifest.taskId, base);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function loadTaskManifest(taskId: string, base: string = configDir()): TaskManifest {
  let value: unknown;
  try { value = JSON.parse(readFileSync(taskManifestPath(taskId, base), "utf8")); }
  catch (err) { throw new Error(`Task ${taskId} could not be loaded: ${err instanceof Error ? err.message : String(err)}`); }
  if (!isManifest(value) || value.taskId !== taskId) throw new Error(`Task ${taskId} has an invalid manifest.`);
  return {
    ...value, version: 2, packs: value.packs ?? [], ownedPaths: value.ownedPaths ?? [],
    coordinatorState: value.coordinatorState ?? "idle", children: value.children ?? []
  };
}

export function listTaskManifests(base: string = configDir()): TaskManifest[] {
  let names: string[];
  try { names = readdirSync(tasksDir(base), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name); }
  catch { return []; }
  const manifests: TaskManifest[] = [];
  for (const name of names) {
    try { manifests.push(loadTaskManifest(name, base)); } catch { /* stale/corrupt entries stay on disk for explicit recovery */ }
  }
  return manifests.sort((a, b) =>
    (b.transitions.at(-1)?.timestamp ?? "").localeCompare(a.transitions.at(-1)?.timestamp ?? "")
  );
}

export function newTaskManifest(
  input: Omit<TaskManifest, "version" | "taskId" | "state" | "transitions" | "artifactPaths" | "packs" |
    "ownedPaths" | "coordinatorState" | "children"> & {
    taskId?: string; packs?: TaskPackIdentity[]; ownedPaths?: string[];
    coordinatorState?: CoordinatorState; children?: TaskChildReference[];
  },
  now: Date = new Date()
): TaskManifest {
  const taskId = input.taskId ?? randomUUID();
  return {
    version: 2, taskId, repositoryId: input.repositoryId, sourcePath: input.sourcePath,
    commonDir: input.commonDir, worktreePath: input.worktreePath, baseCommit: input.baseCommit,
    branch: input.branch, planPath: input.planPath, networkMode: input.networkMode,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.workerRole ? { workerRole: input.workerRole } : {}),
    ...(input.verificationProfile ? { verificationProfile: input.verificationProfile } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    packs: input.packs ?? [], ownedPaths: input.ownedPaths ?? [],
    coordinatorState: input.coordinatorState ?? "idle", children: input.children ?? [], state: "created",
    transitions: [{ state: "created", timestamp: now.toISOString() }], artifactPaths: []
  };
}

export function transitionTask(manifest: TaskManifest, state: TaskState, note?: string, now: Date = new Date()): void {
  if (manifest.state === state) return;
  if (!TRANSITIONS[manifest.state].includes(state)) {
    throw new Error(`Invalid task transition: ${manifest.state} -> ${state}.`);
  }
  manifest.state = state;
  manifest.transitions.push({ state, timestamp: now.toISOString(), ...(note ? { note } : {}) });
}
