import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RunLockError extends Error {
  readonly code = "RUN_LOCKED";
  constructor(message: string) { super(message); this.name = "RunLockError"; }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface RunLock { path: string; release(): void; }

export function acquireRunLock(path: string, now: Date = new Date()): RunLock {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (code !== "EEXIST") throw err;
      let owner: { pid?: unknown; startedAt?: unknown } = {};
      try { owner = JSON.parse(readFileSync(path, "utf8")) as typeof owner; } catch { /* malformed lock is stale */ }
      if (typeof owner.pid === "number" && processAlive(owner.pid)) {
        throw new RunLockError(`Maintenance is already running (pid ${owner.pid}, started ${String(owner.startedAt ?? "unknown")}).`);
      }
      try { unlinkSync(path); } catch { throw new RunLockError("Maintenance lock exists and could not be recovered."); }
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }) + "\n"); }
    finally { closeSync(fd); }
    let released = false;
    return {
      path,
      release: () => { if (!released) { released = true; try { unlinkSync(path); } catch { /* already released */ } } }
    };
  }
  throw new RunLockError("Maintenance lock could not be acquired.");
}
