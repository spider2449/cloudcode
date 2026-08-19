import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedMaintenanceVerification } from "../src/agent/maintenanceExecution.js";
import type { MaintenanceProfile } from "../src/agent/maintenanceConfig.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(script: string): { source: string; base: string; profile: MaintenanceProfile } {
  const root = mkdtempSync(join(tmpdir(), "cc-maint-exec-")); roots.push(root);
  const source = join(root, "source"); const base = join(root, "config");
  execFileSync("git", ["init", source], { windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: source });
  mkdirSync(join(source, ".cloudcode"));
  writeFileSync(join(source, ".cloudcode", "task.json"), JSON.stringify({ profiles: {
    smoke: { commands: [{ command: process.execPath, args: ["-e", script] }] }
  } }));
  writeFileSync(join(source, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-m", "base"], { cwd: source });
  return { source, base, profile: {
    name: "verify", prompt: "", execution: "isolatedVerification", validationProfile: "smoke",
    limits: {}, networkMode: "offlineStrict", source: "project"
  } };
}

describe("isolated maintenance verification", () => {
  it("runs trusted validation in an owned worktree and removes it when clean", async () => {
    const { source, base, profile } = setup("process.stdout.write('ok')");
    const output = await runIsolatedMaintenanceVerification({ cwd: source, configBase: base, profile, trustProjectConfig: true });
    expect(output.exitCode).toBe(0);
    expect(output.report).toContain("Worktree retained: false");
  }, 20_000);

  it("retains a worktree when validation leaves generated files", async () => {
    const { source, base, profile } = setup("require('fs').writeFileSync('generated.txt','evidence')");
    const output = await runIsolatedMaintenanceVerification({ cwd: source, configBase: base, profile, trustProjectConfig: true });
    expect(output.report).toContain("Worktree retained: true");
    const path = /Worktree: (.+)/.exec(output.report)?.[1]?.trim();
    expect(path && existsSync(path)).toBe(true);
  }, 20_000);
});
