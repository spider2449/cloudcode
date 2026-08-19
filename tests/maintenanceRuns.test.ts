import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMaintenanceRuns, loadMaintenanceRun, maintenanceRoot, pruneMaintenanceRuns, saveMaintenanceRun } from "../src/agent/maintenanceRuns.js";
import type { MaintenanceProfile } from "../src/agent/maintenanceConfig.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "cc-maint-runs-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const profile: MaintenanceProfile = {
  name: "health", prompt: "health", execution: "analysis", limits: { maxTurns: 2 },
  networkMode: "offlineStrict", source: "builtin"
};

describe("maintenance run storage", () => {
  it("stores attributable reports and detects identical output", () => {
    const cwd = temp(); const base = temp();
    const first = saveMaintenanceRun({ cwd, base, profile, output: { exitCode: 0, report: "same", events: "{}\n" }, configDigest: "c", packDigest: "p", startedAt: new Date("2026-08-19T00:00:00Z") });
    const second = saveMaintenanceRun({ cwd, base, profile, output: { exitCode: 0, report: "same", events: "{}\n" }, configDigest: "c", packDigest: "p", startedAt: new Date("2026-08-19T01:00:00Z") });
    expect(first.comparison).toBe("first");
    expect(second).toMatchObject({ comparison: "identical", previousRunId: first.runId });
    expect(loadMaintenanceRun(cwd, second.runId, base).report).toBe("same");
  });

  it("prunes owned old runs without following sibling symlinks", () => {
    const cwd = temp(); const base = temp(); const outside = temp();
    for (let index = 0; index < 3; index++) saveMaintenanceRun({ cwd, base, profile, output: { exitCode: 0, report: String(index), events: "" }, configDigest: "c", packDigest: "p", startedAt: new Date(2026, 7, 19, index) });
    const root = maintenanceRoot(cwd, base);
    mkdirSync(root, { recursive: true });
    try { symlinkSync(outside, join(root, "00000000-0000-0000-0000-000000000000"), "junction"); } catch { /* symlink creation may be unavailable */ }
    expect(pruneMaintenanceRuns(cwd, { base, maxRuns: 1, maxBytes: 1024 * 1024 })).toHaveLength(2);
    expect(listMaintenanceRuns(cwd, base)).toHaveLength(1);
  });
});
