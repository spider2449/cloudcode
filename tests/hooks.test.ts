import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooksConfig, HooksRunner } from "../src/agent/hooks.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "../src/agent/projectTrust.js";

function project(hooksJson?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-hooks-"));
  if (hooksJson !== undefined) {
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(cwd, ".cloudcode", "hooks.json"), hooksJson);
  }
  return cwd;
}

function fakeExecutor(result: { code: number; stderr?: string }, calls: Array<{ command: string; input: string }> = []) {
  return async (command: string, options: { input: string }) => {
    calls.push({ command, input: options.input });
    return { code: result.code, stderr: result.stderr ?? "" };
  };
}

describe("loadHooksConfig", () => {
  it("merges user entries before project entries per event", () => {
    const base = mkdtempSync(join(tmpdir(), "cc-hooks-user-"));
    writeFileSync(join(base, "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ command: "user-a" }] }
    }));
    const cwd = project(JSON.stringify({
      hooks: { Stop: [{ command: "proj-a" }] }
    }));
    const trust = new ProjectTrustStore(join(mkdtempSync(join(tmpdir(), "cc-hooks-trust-")), "trusted.json"));
    // Approve whatever the descriptor says so the project layer loads.
    const descriptor = inspectProjectExecutableConfig(cwd, base);
    if (descriptor) trust.approve(descriptor);
    const config = loadHooksConfig(cwd, base, trust);
    expect(config.hooks.Stop?.map(e => e.command)).toEqual(["user-a", "proj-a"]);
    expect(config.projectUntrusted).toBe(false);
  });

  it("ignores an untrusted project file but flags it", () => {
    const base = mkdtempSync(join(tmpdir(), "cc-hooks-user2-"));
    const cwd = project(JSON.stringify({ hooks: { Stop: [{ command: "proj" }] } }));
    const config = loadHooksConfig(cwd, base, new ProjectTrustStore(join(mkdtempSync(join(tmpdir(), "cc-hooks-trust2-")), "trusted.json")));
    expect(config.hooks.Stop).toBeUndefined();
    expect(config.projectUntrusted).toBe(true);
  });

  it("skips invalid entries with warnings", () => {
    const base = mkdtempSync(join(tmpdir(), "cc-hooks-user3-"));
    writeFileSync(join(base, "hooks.json"), JSON.stringify({
      hooks: {
        NotAnEvent: [{ command: "x" }],
        Stop: [{ command: "" }, { timeoutMs: -1 }, { command: "ok", timeoutMs: 5000 }]
      }
    }));
    const config = loadHooksConfig(project(), base, new ProjectTrustStore(join(mkdtempSync(join(tmpdir(), "cc-t3-")), "trusted.json")));
    expect(config.warnings.length).toBeGreaterThan(0);
    expect(config.hooks.Stop?.map(e => e.command)).toEqual(["ok"]);
    expect(config.hooks.NotAnEvent).toBeUndefined();
  });
});

describe("HooksRunner", () => {
  it("passes event JSON on stdin and reports notices for failures", async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const runner = new HooksRunner({ Stop: [{ command: "a" }, { command: "b" }] }, "/tmp", fakeExecutor({ code: 3, stderr: "oops" }, calls));
    const outcome = await runner.run("Stop", { sessionId: "s1" });
    expect(outcome.blocked).toBe(false);
    expect(outcome.notices.length).toBe(2);
    expect(calls[0].command).toBe("a");
    const parsed = JSON.parse(calls[0].input);
    expect(parsed.event).toBe("Stop");
    expect(parsed.sessionId).toBe("s1");
  });

  it("blocks on failure for PreToolUse with stderr as reason", async () => {
    const runner = new HooksRunner({ PreToolUse: [{ command: "guard" }] }, "/tmp",
      fakeExecutor({ code: 1, stderr: "no writes on friday" }));
    const outcome = await runner.run("PreToolUse", { tool: "Edit" });
    expect(outcome.blocked).toBe(true);
    expect(outcome.notices.join(" ")).toContain("no writes on friday");
  });

  it("treats a timeout as a failure (fail-closed for PreToolUse)", async () => {
    const runner = new HooksRunner({ PreToolUse: [{ command: "slow" }] }, "/tmp",
      async () => { throw new Error("timed out"); });
    const outcome = await runner.run("PreToolUse", {});
    expect(outcome.blocked).toBe(true);
  });

  it("returns success without executing anything when no entries exist", async () => {
    let executed = 0;
    const runner = new HooksRunner({}, "/tmp", async () => { executed += 1; return { code: 0 }; });
    const outcome = await runner.run("Stop", {});
    expect(outcome.blocked).toBe(false);
    expect(executed).toBe(0);
  });
});

