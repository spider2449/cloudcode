import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { configDir } from "./providers.js";
import type { MaintenanceProfile } from "./maintenanceConfig.js";

export interface MaintenanceRunRecord {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  projectPath: string;
  profile: string;
  profileSource: string;
  execution: MaintenanceProfile["execution"];
  networkMode: MaintenanceProfile["networkMode"];
  limits: MaintenanceProfile["limits"];
  head: string;
  dirtyFingerprint: string;
  configDigest: string;
  packDigest: string;
  sessionId?: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  reportDigest: string;
  comparison: "first" | "identical" | "changed";
  previousRunId?: string;
}

export interface MaintenanceRunOutput { exitCode: number; report: string; events: string; sessionId?: string; }

function canonical(path: string): string {
  try { return realpathSync.native(resolve(path)); } catch { return resolve(path); }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

export function maintenanceProjectId(cwd: string): string {
  const path = process.platform === "win32" ? canonical(cwd).toLowerCase() : canonical(cwd);
  return hash(path).slice(0, 20);
}

export function captureMaintenanceState(cwd: string): { head: string; dirtyFingerprint: string } {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { head, dirtyFingerprint: hash(status.replaceAll("\r\n", "\n")) };
}

export function maintenanceRoot(cwd: string, base: string = configDir()): string {
  return join(base, "projects", maintenanceProjectId(cwd), "maintenance");
}

function atomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function listMaintenanceRuns(cwd: string, base: string = configDir()): MaintenanceRunRecord[] {
  const root = maintenanceRoot(cwd, base);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const records: MaintenanceRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const value = JSON.parse(readFileSync(join(root, entry.name, "run.json"), "utf8")) as MaintenanceRunRecord;
      if (value.schemaVersion === 1 && value.runId === entry.name) records.push(value);
    } catch { /* corrupt runs remain for explicit inspection */ }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function loadMaintenanceRun(cwd: string, runId: string, base: string = configDir()): {
  record: MaintenanceRunRecord; report: string; events: string;
} {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error(`Invalid maintenance run id: ${runId}.`);
  const dir = join(maintenanceRoot(cwd, base), runId);
  const record = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as MaintenanceRunRecord;
  if (record.runId !== runId || record.projectId !== maintenanceProjectId(cwd)) throw new Error("Maintenance run identity mismatch.");
  return { record, report: readFileSync(join(dir, "report.md"), "utf8"), events: readFileSync(join(dir, "events.jsonl"), "utf8") };
}

export function saveMaintenanceRun(input: {
  cwd: string; profile: MaintenanceProfile; output: MaintenanceRunOutput;
  configDigest: string; packDigest: string; startedAt: Date; completedAt?: Date; base?: string;
}): MaintenanceRunRecord {
  const base = input.base ?? configDir();
  const root = maintenanceRoot(input.cwd, base);
  const runId = randomUUID();
  const state = captureMaintenanceState(input.cwd);
  const reportDigest = hash(input.output.report);
  const previous = listMaintenanceRuns(input.cwd, base)[0];
  const record: MaintenanceRunRecord = {
    schemaVersion: 1, runId, projectId: maintenanceProjectId(input.cwd), projectPath: canonical(input.cwd),
    profile: input.profile.name, profileSource: input.profile.source, execution: input.profile.execution,
    networkMode: input.profile.networkMode, limits: input.profile.limits, ...state,
    configDigest: input.configDigest, packDigest: input.packDigest,
    ...(input.output.sessionId ? { sessionId: input.output.sessionId } : {}),
    startedAt: input.startedAt.toISOString(), completedAt: (input.completedAt ?? new Date()).toISOString(),
    exitCode: input.output.exitCode, reportDigest,
    comparison: !previous ? "first" : previous.reportDigest === reportDigest ? "identical" : "changed",
    ...(previous ? { previousRunId: previous.runId } : {})
  };
  const dir = join(root, runId);
  atomic(join(dir, "report.md"), input.output.report);
  atomic(join(dir, "events.jsonl"), input.output.events);
  atomic(join(dir, "run.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

export function pruneMaintenanceRuns(cwd: string, options: {
  maxRuns: number; maxBytes: number; base?: string;
}): string[] {
  const root = maintenanceRoot(cwd, options.base);
  const resolvedRoot = resolve(root);
  const records = listMaintenanceRuns(cwd, options.base);
  let bytes = 0;
  const removed: string[] = [];
  for (const [index, record] of records.entries()) {
    const dir = resolve(root, record.runId);
    if (!dir.startsWith(resolvedRoot + sep)) continue;
    let size = 0;
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && !entry.isSymbolicLink()) size += lstatSync(join(dir, entry.name)).size;
      }
    } catch { continue; }
    bytes += size;
    if (index >= options.maxRuns || bytes > options.maxBytes) {
      rmSync(dir, { recursive: true, force: false });
      removed.push(record.runId);
    }
  }
  return removed;
}
