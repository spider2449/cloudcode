import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerRole } from "./taskManifest.js";

export interface WorkerEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  workerId: string;
  role: WorkerRole;
  kind: "worker.started" | "worker.progress" | "worker.completed" | "worker.failed" | "worker.cancelled";
  message?: string;
}

export interface WorkerJob<T> {
  workerId: string;
  role: WorkerRole;
  eventLogPath: string;
  run(signal: AbortSignal, emit: (message: string) => void): Promise<T>;
}

export interface WorkerResult<T> { workerId: string; status: "completed" | "failed" | "cancelled"; value?: T; error?: string; }

export class WorkerScheduler {
  private controller = new AbortController();
  private sequence = 0;
  private maxBytes: number;

  constructor(private options: {
    concurrency?: number; explicitParallel?: boolean; maxEventBytes?: number;
    onEvent?: (event: WorkerEvent) => void; now?: () => Date;
  } = {}) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
      throw new Error("Worker concurrency must be between 1 and 3.");
    }
    if (concurrency > 1 && !options.explicitParallel) throw new Error("Parallel workers require explicit acknowledgement.");
    this.maxBytes = options.maxEventBytes ?? 5 * 1024 * 1024;
  }

  cancel(reason = "coordinator cancelled"): void {
    if (!this.controller.signal.aborted) this.controller.abort(new Error(reason));
  }

  private emit(job: WorkerJob<unknown>, kind: WorkerEvent["kind"], message?: string): void {
    const event: WorkerEvent = {
      schemaVersion: 1, sequence: ++this.sequence,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      workerId: job.workerId, role: job.role, kind, ...(message ? { message } : {})
    };
    this.options.onEvent?.(event);
    mkdirSync(dirname(job.eventLogPath), { recursive: true });
    let size = 0;
    try { size = statSync(job.eventLogPath).size; } catch { /* first event */ }
    const line = JSON.stringify(event) + "\n";
    if (size + Buffer.byteLength(line) <= this.maxBytes) appendFileSync(job.eventLogPath, line, { encoding: "utf8", mode: 0o600 });
  }

  async run<T>(jobs: WorkerJob<T>[]): Promise<WorkerResult<T>[]> {
    const results: WorkerResult<T>[] = [];
    let index = 0;
    const consume = async () => {
      for (;;) {
        const current = index++;
        const job = jobs[current];
        if (!job) return;
        if (this.controller.signal.aborted) {
          this.emit(job, "worker.cancelled"); results[current] = { workerId: job.workerId, status: "cancelled" }; continue;
        }
        this.emit(job, "worker.started");
        try {
          const value = await job.run(this.controller.signal, message => this.emit(job, "worker.progress", message));
          if (this.controller.signal.aborted) {
            this.emit(job, "worker.cancelled"); results[current] = { workerId: job.workerId, status: "cancelled" };
          } else {
            this.emit(job, "worker.completed"); results[current] = { workerId: job.workerId, status: "completed", value };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const cancelled = this.controller.signal.aborted;
          this.emit(job, cancelled ? "worker.cancelled" : "worker.failed", message);
          results[current] = { workerId: job.workerId, status: cancelled ? "cancelled" : "failed", error: message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 1, jobs.length) }, consume));
    return results;
  }
}
