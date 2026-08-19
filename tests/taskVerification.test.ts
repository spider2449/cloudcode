import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadVerificationProfiles, runVerification, type VerificationRunner
} from "../src/agent/taskVerification.js";

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "cc-verify-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("task verification", () => {
  it("loads strict project profiles and reports malformed commands", () => {
    const cwd = root();
    mkdirSync(join(cwd, ".cloudcode"));
    writeFileSync(join(cwd, ".cloudcode", "task.json"), JSON.stringify({ profiles: {
      focused: { commands: [{ command: "npm", args: ["test"], timeoutMs: 1000 }] },
      bad: { commands: [{ command: 42 }] }
    } }));
    const loaded = loadVerificationProfiles(cwd);
    expect(loaded.profiles).toEqual([{
      name: "focused", commands: [{ command: "npm", args: ["test"], timeoutMs: 1000 }]
    }]);
    expect(loaded.warnings).toContain("bad: invalid command entry.");
  });

  it("runs sequentially, emits attributable events, and stops on failure", async () => {
    const events: unknown[] = [];
    const runner: VerificationRunner = vi.fn(async entry => ({
      command: entry.command, args: entry.args, code: entry.command === "fail" ? 1 : 0,
      stdout: "out", stderr: "", durationMs: 1, timedOut: false, interrupted: false, truncated: false
    }));
    const result = await runVerification({
      cwd: root(), profile: { name: "test", commands: [
        { command: "ok", args: [], timeoutMs: 100 }, { command: "fail", args: [], timeoutMs: 100 },
        { command: "never", args: [], timeoutMs: 100 }
      ] }, runner, onEvent: event => events.push(event)
    });
    expect(result.success).toBe(false);
    expect(result.commands.map(command => command.command)).toEqual(["ok", "fail"]);
    expect(events).toHaveLength(4);
  });

  it("bounds output and interrupts a real child process", async () => {
    const cwd = root();
    const controller = new AbortController();
    const command = process.execPath;
    const pending = runVerification({
      cwd, signal: controller.signal, profile: { name: "interrupt", commands: [{
        command, args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(5000)), 1)"], timeoutMs: 5000
      }] }
    });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.commands[0].interrupted).toBe(true);
    expect(Buffer.byteLength(result.commands[0].stdout)).toBeLessThanOrEqual(128 * 1024);
  });
});
