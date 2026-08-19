import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerScheduler, type WorkerJob } from "../src/agent/workerScheduler.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "cc-workers-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("worker scheduler", () => {
  it("defaults to serial execution and multiplexes worker identity into durable events", async () => {
    const root = temp(); let active = 0; let peak = 0;
    const jobs: WorkerJob<string>[] = ["a", "b"].map(workerId => ({
      workerId, role: "research", eventLogPath: join(root, `${workerId}.jsonl`),
      run: async (_signal, emit) => { active++; peak = Math.max(peak, active); emit("working"); await new Promise(resolve => setImmediate(resolve)); active--; return workerId; }
    }));
    const results = await new WorkerScheduler().run(jobs);
    expect(peak).toBe(1);
    expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
    expect(readFileSync(join(root, "a.jsonl"), "utf8")).toContain('"workerId":"a"');
  });

  it("requires explicit parallel acknowledgement and respects the hard cap", () => {
    expect(() => new WorkerScheduler({ concurrency: 2 })).toThrow(/explicit/);
    expect(() => new WorkerScheduler({ concurrency: 4, explicitParallel: true })).toThrow(/between 1 and 3/);
  });

  it("propagates cancellation and waits for workers to stop", async () => {
    const root = temp();
    const scheduler = new WorkerScheduler();
    const running = scheduler.run([{ workerId: "a", role: "implement", eventLogPath: join(root, "a.jsonl"), run: signal =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }]);
    await new Promise(resolve => setImmediate(resolve));
    scheduler.cancel();
    expect(await running).toEqual([{ workerId: "a", status: "cancelled", error: "coordinator cancelled" }]);
  });
});
