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

export interface TaskManifest {
  version: 1;
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

function isManifest(value: unknown): value is TaskManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TaskManifest>;
  return item.version === 1 && typeof item.taskId === "string" && typeof item.repositoryId === "string" &&
    typeof item.sourcePath === "string" && typeof item.commonDir === "string" && typeof item.worktreePath === "string" &&
    typeof item.baseCommit === "string" && typeof item.branch === "string" && isState(item.state) &&
    Array.isArray(item.transitions) && item.transitions.length > 0 && typeof item.planPath === "string" && Array.isArray(item.artifactPaths) &&
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
  return value;
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
  input: Omit<TaskManifest, "version" | "taskId" | "state" | "transitions" | "artifactPaths"> & { taskId?: string },
  now: Date = new Date()
): TaskManifest {
  const taskId = input.taskId ?? randomUUID();
  return {
    version: 1, taskId, repositoryId: input.repositoryId, sourcePath: input.sourcePath,
    commonDir: input.commonDir, worktreePath: input.worktreePath, baseCommit: input.baseCommit,
    branch: input.branch, planPath: input.planPath, networkMode: input.networkMode,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.verificationProfile ? { verificationProfile: input.verificationProfile } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    state: "created", transitions: [{ state: "created", timestamp: now.toISOString() }], artifactPaths: []
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
