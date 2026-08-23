import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { bashTool } from "../src/engine/tools/bash.js";

const ctx = { cwd: process.cwd() };

describe("bashTool", () => {
  it("captures stdout", async () => {
    const out = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("hello");
  });
  it("reports nonzero exit as error with output", async () => {
    const out = await bashTool.execute({ command: "exit 3" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("exit code 3");
  });
  it("times out long commands", async () => {
    const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
    const out = await bashTool.execute({ command: sleep, timeout: 500 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content.toLowerCase()).toContain("timed out");
  }, 15000);

  it("kills the command and reports an interrupt when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = bashTool.execute(
      // A sleep long enough that only an abort can end it quickly.
      { command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30" },
      { cwd: process.cwd(), signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 200);
    const out = await pending;
    expect(Date.now() - started).toBeLessThan(10000);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Interrupted by user");
  }, 15000);

  it("wraps the spawned command when a sandbox is present", async () => {
    const seen: string[] = [];
    const out = await bashTool.execute(
      { command: "echo wrapped-hello" },
      {
        cwd: process.cwd(),
        sandbox: {
          wrap(command: string) {
            // A binary name that cannot exist: proves the wrapped argv is what
            // executes, and that there is no unwrapped retry.
            seen.push(command);
            return { cmd: "cc-nonexistent-sandbox-bin", args: ["-c", command] };
          }
        }
      }
    );
    expect(seen.join(" ")).toContain("echo wrapped-hello");
    expect(out.isError).toBe(true);
  }, 15000);

  it("executes successfully inside a real netns sandbox on Linux", async () => {
    if (process.platform === "win32") return;
    // A nonzero status means unshare exists but lacks permission to create
    // a netns here (spawn's .error only covers ENOENT-style failures).
    const probe = spawnSync("unshare", ["-n", "true"]);
    if (probe.error || probe.status !== 0) return;
    const out = await bashTool.execute(
      { command: "cat /sys/class/net/lo/operstate" },
      { cwd: process.cwd(), sandbox: { wrap: c => ({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", c] }) } }
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("down");
  }, 15000);
});
