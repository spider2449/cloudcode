import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, RunLockError } from "../src/agent/runLock.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("maintenance run lock", () => {
  it("rejects overlap and permits another run after release", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-run-lock-")); roots.push(root);
    const path = join(root, "run.lock");
    const first = acquireRunLock(path);
    expect(() => acquireRunLock(path)).toThrow(RunLockError);
    first.release();
    expect(() => acquireRunLock(path).release()).not.toThrow();
  });

  it("recovers a lock owned by a process that no longer exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-run-lock-")); roots.push(root);
    const path = join(root, "run.lock");
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, startedAt: "old" }));
    expect(() => acquireRunLock(path).release()).not.toThrow();
  });
});
