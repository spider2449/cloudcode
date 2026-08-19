import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMaintainCommand, type MaintenanceExecutor } from "../src/commands/cli/maintain.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "cc-cli-maint-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("maintain CLI", () => {
  it("lists profiles, runs one, and exposes local history and reports", async () => {
    const cwd = temp(); const base = temp();
    const execute: MaintenanceExecutor = vi.fn(async () => ({
      exitCode: 0, report: "# Health\nclean", events: "{\"event\":\"done\"}\n", sessionId: "session-1"
    }));
    expect((await runMaintainCommand(["list"], { cwd, base, execute })).stdout).toContain("health  analysis");
    const run = await runMaintainCommand(["run", "health", "--output-format", "json"], { cwd, base, execute });
    expect(run.exitCode).toBe(0);
    const document = JSON.parse(run.stdout ?? "{}") as { record: { runId: string }; report: string };
    expect(document.report).toContain("clean");
    expect((await runMaintainCommand(["history"], { cwd, base, execute })).stdout).toContain(document.record.runId);
    expect((await runMaintainCommand(["show", document.record.runId], { cwd, base, execute })).stdout).toContain("# Health");
  });

  it("uses a stable conflict code for overlapping project runs", async () => {
    const cwd = temp(); const base = temp();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const execute: MaintenanceExecutor = async () => { await wait; return { exitCode: 0, report: "ok", events: "" }; };
    const first = runMaintainCommand(["run", "health"], { cwd, base, execute });
    await new Promise(resolve => setImmediate(resolve));
    expect((await runMaintainCommand(["run", "health"], { cwd, base, execute })).exitCode).toBe(6);
    release();
    await first;
  });
});
