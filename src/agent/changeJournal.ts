import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configDir } from "./providers.js";
import type { FileMutationObserver, FileMutationToken } from "../engine/tools/types.js";

const DEFAULT_FILE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_SESSION_LIMIT = 100 * 1024 * 1024;
const DEFAULT_CHECKPOINT_LIMIT = 20;
const DEFAULT_DIFF_LIMIT = 200 * 1024;

type ChangeKind = "added" | "modified";
type CheckpointStatus = "active" | "complete" | "undone";

interface StoredChange {
  requestedPath: string;
  canonicalPath: string;
  kind: ChangeKind;
  beforeDigest?: string;
  beforeBlob?: string;
  beforeMode?: number;
  afterDigest?: string;
  afterExists: boolean;
  undoUnavailable?: string;
}

interface StoredCheckpoint {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: CheckpointStatus;
  changes: StoredChange[];
}

interface Manifest {
  version: 1;
  projectPath: string;
  sessionId: string;
  checkpoints: StoredCheckpoint[];
}

interface PendingMutation {
  checkpointId: string;
  canonicalPath: string;
}

export interface ChangeEntry {
  path: string;
  kind: ChangeKind;
  undoAvailable: boolean;
  unavailableReason?: string;
}

export interface ChangeSummary {
  id: string;
  startedAt: string;
  status: CheckpointStatus;
  changes: ChangeEntry[];
}

export interface UndoOperation {
  path: string;
  action: "restore" | "remove";
}

export interface UndoPreview {
  checkpointId?: string;
  operations: UndoOperation[];
  conflicts: string[];
}

export interface UndoResult extends UndoPreview {
  applied: boolean;
  rollbackErrors: string[];
}

export interface ChangeJournalOptions {
  rootDir?: string;
  fileLimit?: number;
  sessionLimit?: number;
  checkpointLimit?: number;
  diffLimit?: number;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return existsSync(parent) ? join(realpathSync.native(parent), basename(path)) : resolve(path);
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.projectPath !== "string" ||
    typeof candidate.sessionId !== "string" || !Array.isArray(candidate.checkpoints)) return false;
  return candidate.checkpoints.every(checkpoint => {
    if (typeof checkpoint !== "object" || checkpoint === null) return false;
    const item = checkpoint as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.startedAt !== "string" ||
      !["active", "complete", "undone"].includes(String(item.status)) || !Array.isArray(item.changes)) return false;
    return item.changes.every(change => {
      if (typeof change !== "object" || change === null) return false;
      const file = change as Record<string, unknown>;
      return typeof file.requestedPath === "string" && typeof file.canonicalPath === "string" &&
        (file.kind === "added" || file.kind === "modified") && typeof file.afterExists === "boolean";
    });
  });
}

function atomicWrite(path: string, content: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function isText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8000));
  return !sample.includes(0);
}

function renderSimpleDiff(path: string, before: Buffer, after: Buffer): string {
  if (!isText(before) || !isText(after)) {
    return `--- ${path}\n+++ ${path}\nBinary file changed (${before.length} -> ${after.length} bytes)\n`;
  }
  const oldLines = before.toString("utf8").split("\n");
  const newLines = after.toString("utf8").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const out = [`--- ${path}`, `+++ ${path}`, `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`];
  for (let i = contextStart; i < prefix; i++) out.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldLines.length - suffix; i++) out.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newLines.length - suffix; i++) out.push(`+${newLines[i]}`);
  const suffixStart = Math.max(prefix, newLines.length - suffix);
  for (let i = suffixStart; i < newEnd; i++) out.push(` ${newLines[i]}`);
  return out.join("\n") + "\n";
}

export class ChangeJournal implements FileMutationObserver {
  private readonly rootDir: string;
  private readonly blobDir: string;
  private readonly manifestPath: string;
  private readonly fileLimit: number;
  private readonly sessionLimit: number;
  private readonly checkpointLimit: number;
  private readonly diffLimit: number;
  private manifest: Manifest;
  private active: StoredCheckpoint | undefined;
  private pending = new Map<string, PendingMutation>();
  private loadWarnings: string[] = [];

  constructor(projectPath: string, sessionId: string, options: ChangeJournalOptions = {}) {
    this.rootDir = options.rootDir ?? join(configDir(), "checkpoints", sessionId);
    this.blobDir = join(this.rootDir, "blobs");
    this.manifestPath = join(this.rootDir, "manifest.json");
    this.fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
    this.sessionLimit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT;
    this.checkpointLimit = options.checkpointLimit ?? DEFAULT_CHECKPOINT_LIMIT;
    this.diffLimit = options.diffLimit ?? DEFAULT_DIFF_LIMIT;
    this.manifest = { version: 1, projectPath: resolve(projectPath), sessionId, checkpoints: [] };
    this.load();
  }

  warnings(): string[] {
    return [...this.loadWarnings];
  }

  beginCheckpoint(): string {
    if (this.active) throw new Error("A change checkpoint is already active");
    const checkpoint: StoredCheckpoint = {
      id: randomUUID(), startedAt: new Date().toISOString(), status: "active", changes: []
    };
    this.manifest.checkpoints.push(checkpoint);
    this.active = checkpoint;
    this.save();
    return checkpoint.id;
  }

  finishCheckpoint(): ChangeSummary | undefined {
    const checkpoint = this.active;
    if (!checkpoint) return undefined;
    checkpoint.changes = checkpoint.changes.filter(change =>
      change.undoUnavailable !== undefined || change.kind === "added" || change.beforeDigest !== change.afterDigest
    );
    this.active = undefined;
    this.pending.clear();
    if (checkpoint.changes.length === 0) {
      this.manifest.checkpoints = this.manifest.checkpoints.filter(item => item !== checkpoint);
      this.save();
      return undefined;
    }
    checkpoint.status = "complete";
    checkpoint.completedAt = new Date().toISOString();
    this.prune();
    this.save();
    return this.toSummary(checkpoint);
  }

  async before(path: string): Promise<FileMutationToken> {
    if (!this.active) throw new Error("File mutation attempted outside an active checkpoint");
    const requestedPath = resolve(path);
    const canonical = canonicalPath(requestedPath);
    let change = this.active.changes.find(item => normalizeIdentity(item.canonicalPath) === normalizeIdentity(canonical));
    if (!change) {
      const exists = existsSync(canonical);
      change = {
        requestedPath,
        canonicalPath: canonical,
        kind: exists ? "modified" : "added",
        afterExists: exists
      };
      if (exists) {
        const info = statSync(canonical);
        change.beforeMode = info.mode;
        if (info.size > this.fileLimit) {
          change.undoUnavailable = `file exceeds ${this.fileLimit} byte checkpoint limit`;
        } else {
          const content = readFileSync(canonical);
          if (this.blobBytes() + content.length > this.sessionLimit) {
            change.undoUnavailable = `session exceeds ${this.sessionLimit} byte checkpoint limit`;
          } else {
            change.beforeDigest = this.writeBlob(content);
            change.beforeBlob = change.beforeDigest;
          }
        }
      }
      this.active.changes.push(change);
      this.save();
    }
    const token = { id: randomUUID() };
    this.pending.set(token.id, { checkpointId: this.active.id, canonicalPath: change.canonicalPath });
    return token;
  }

  async after(token: FileMutationToken): Promise<void> {
    const pending = this.pending.get(token.id);
    this.pending.delete(token.id);
    if (!pending || !this.active || pending.checkpointId !== this.active.id) return;
    const change = this.active.changes.find(item => item.canonicalPath === pending.canonicalPath);
    if (!change) return;
    change.afterExists = existsSync(change.canonicalPath);
    change.afterDigest = change.afterExists ? digest(readFileSync(change.canonicalPath)) : undefined;
    this.save();
  }

  listChanges(latestOnly = false): ChangeSummary[] {
    const checkpoints = this.manifest.checkpoints.filter(item => item.status !== "active");
    const latest = [...checkpoints].reverse().find(item => item.status === "complete");
    const selected = latestOnly ? (latest ? [latest] : []) : checkpoints;
    return selected.slice().reverse().map(item => this.toSummary(item));
  }

  diff(path?: string): { content: string; truncated: boolean } {
    const filterPath = path ? normalizeIdentity(resolve(this.manifest.projectPath, path)) : undefined;
    const firstByPath = new Map<string, StoredChange>();
    for (const checkpoint of this.manifest.checkpoints) {
      if (checkpoint.status !== "complete") continue;
      for (const change of checkpoint.changes) {
        const key = normalizeIdentity(change.canonicalPath);
        if (!firstByPath.has(key)) firstByPath.set(key, change);
      }
    }
    let output = "";
    let truncated = false;
    for (const [key, change] of firstByPath) {
      if (filterPath && key !== filterPath && normalizeIdentity(change.requestedPath) !== filterPath) continue;
      if (change.undoUnavailable) {
        output += `${change.requestedPath}: diff unavailable (${change.undoUnavailable})\n`;
        continue;
      }
      const before = change.kind === "added" ? Buffer.alloc(0) : this.readBlob(change.beforeBlob);
      const after = existsSync(change.canonicalPath) ? readFileSync(change.canonicalPath) : Buffer.alloc(0);
      const block = renderSimpleDiff(change.requestedPath, before, after);
      if (Buffer.byteLength(output + block) > this.diffLimit) {
        truncated = true;
        break;
      }
      output += block;
    }
    if (truncated) output += `\n... diff truncated at ${this.diffLimit} bytes\n`;
    return { content: output || "No session-owned changes.", truncated };
  }

  previewUndo(): UndoPreview {
    const checkpoint = [...this.manifest.checkpoints].reverse().find(item => item.status === "complete");
    if (!checkpoint) return { operations: [], conflicts: [] };
    const operations: UndoOperation[] = [];
    const conflicts: string[] = [];
    for (const change of checkpoint.changes) {
      if (change.undoUnavailable) {
        conflicts.push(`${change.requestedPath}: ${change.undoUnavailable}`);
        continue;
      }
      let currentCanonical: string;
      try { currentCanonical = canonicalPath(change.requestedPath); }
      catch { currentCanonical = resolve(change.requestedPath); }
      if (normalizeIdentity(currentCanonical) !== normalizeIdentity(change.canonicalPath)) {
        conflicts.push(`${change.requestedPath}: filesystem identity changed`);
        continue;
      }
      const exists = existsSync(change.canonicalPath);
      const currentDigest = exists ? digest(readFileSync(change.canonicalPath)) : undefined;
      if (exists !== change.afterExists || currentDigest !== change.afterDigest) {
        conflicts.push(`${change.requestedPath}: content changed after checkpoint`);
        continue;
      }
      operations.push({ path: change.requestedPath, action: change.kind === "added" ? "remove" : "restore" });
    }
    return { checkpointId: checkpoint.id, operations, conflicts };
  }

  undoLatest(): UndoResult {
    const preview = this.previewUndo();
    if (!preview.checkpointId || preview.conflicts.length > 0) {
      return { ...preview, applied: false, rollbackErrors: [] };
    }
    const checkpoint = this.manifest.checkpoints.find(item => item.id === preview.checkpointId);
    if (!checkpoint) return { ...preview, applied: false, rollbackErrors: [] };
    const applied: Array<{ change: StoredChange; backup: string }> = [];
    const rollbackErrors: string[] = [];
    try {
      for (const change of checkpoint.changes) {
        const backup = join(dirname(change.canonicalPath), `.${basename(change.canonicalPath)}.${randomUUID()}.undo`);
        renameSync(change.canonicalPath, backup);
        applied.push({ change, backup });
        if (change.kind === "modified") {
          atomicWrite(change.canonicalPath, this.readBlob(change.beforeBlob));
          if (change.beforeMode !== undefined) chmodSync(change.canonicalPath, change.beforeMode);
        }
      }
      for (const item of applied) rmSync(item.backup, { force: true });
      checkpoint.status = "undone";
      this.save();
      return { ...preview, applied: true, rollbackErrors };
    } catch (err) {
      for (const item of applied.reverse()) {
        try {
          if (existsSync(item.change.canonicalPath)) unlinkSync(item.change.canonicalPath);
          renameSync(item.backup, item.change.canonicalPath);
        } catch (rollbackErr) {
          rollbackErrors.push(`${item.change.requestedPath}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
      }
      return {
        ...preview,
        conflicts: [...preview.conflicts, `Undo failed: ${err instanceof Error ? err.message : String(err)}`],
        applied: false,
        rollbackErrors
      };
    }
  }

  private load(): void {
    if (!existsSync(this.manifestPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.manifestPath, "utf8"));
      if (!isManifest(parsed)) throw new Error("invalid checkpoint manifest shape");
      if (parsed.sessionId !== this.manifest.sessionId ||
        normalizeIdentity(parsed.projectPath) !== normalizeIdentity(this.manifest.projectPath)) {
        this.loadWarnings.push("Checkpoint journal belongs to a different project or session and was ignored.");
        return;
      }
      this.manifest = parsed;
      for (const checkpoint of this.manifest.checkpoints) {
        if (checkpoint.status === "active") {
          checkpoint.status = "complete";
          checkpoint.completedAt ??= new Date().toISOString();
        }
      }
    } catch (err) {
      this.loadWarnings.push(`Checkpoint manifest ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(): void {
    atomicWrite(this.manifestPath, JSON.stringify(this.manifest, null, 2) + "\n");
  }

  private writeBlob(content: Buffer): string {
    const hash = digest(content);
    const path = join(this.blobDir, hash);
    if (!existsSync(path)) atomicWrite(path, content);
    return hash;
  }

  private readBlob(name: string | undefined): Buffer {
    if (!name) throw new Error("Checkpoint before-image is missing");
    return readFileSync(join(this.blobDir, name));
  }

  private blobBytes(): number {
    try {
      return readdirSync(this.blobDir).reduce((total, name) => total + lstatSync(join(this.blobDir, name)).size, 0);
    } catch {
      return 0;
    }
  }

  private prune(): void {
    const completed = this.manifest.checkpoints.filter(item => item.status !== "active");
    if (completed.length <= this.checkpointLimit) return;
    const remove = new Set(completed.slice(0, completed.length - this.checkpointLimit).map(item => item.id));
    this.manifest.checkpoints = this.manifest.checkpoints.filter(item => !remove.has(item.id));
    const retainedBlobs = new Set(this.manifest.checkpoints.flatMap(checkpoint =>
      checkpoint.changes.flatMap(change => change.beforeBlob ? [change.beforeBlob] : [])
    ));
    try {
      for (const name of readdirSync(this.blobDir)) {
        if (!retainedBlobs.has(name)) rmSync(join(this.blobDir, name), { force: true });
      }
    } catch { /* blob directory may not exist */ }
  }

  private toSummary(checkpoint: StoredCheckpoint): ChangeSummary {
    return {
      id: checkpoint.id,
      startedAt: checkpoint.startedAt,
      status: checkpoint.status,
      changes: checkpoint.changes.map(change => ({
        path: change.requestedPath,
        kind: change.kind,
        undoAvailable: change.undoUnavailable === undefined,
        unavailableReason: change.undoUnavailable
      }))
    };
  }
}
