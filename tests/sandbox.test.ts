import { describe, it, expect, beforeEach } from "vitest";
import {
  probeSandbox, probeSandboxCached, resetSandboxCacheForTests,
  type SandboxRunner
} from "../src/agent/sandbox.js";

const PROBE = 'for i in /sys/class/net/*; do printf "%s %s\\n" "${i##*/}" "$(cat "$i/operstate")"; done';

function runnerWith(results: Record<string, { status: number | null; stdout: string }>): SandboxRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = results[key];
    if (!hit) throw new Error(`unexpected invocation: ${key}`);
    return hit;
  };
}
const unshareRun = (status: number | null, stdout: string) => ({
  [`unshare -n /bin/sh -c ${PROBE}`]: { status, stdout }
});
const bwrapRun = (status: number | null, stdout: string) => ({
  [`bwrap --unshare-net --dev-bind / / /bin/sh -c ${PROBE}`]: { status, stdout }
});

describe("probeSandbox", () => {
  beforeEach(() => resetSandboxCacheForTests());

  it("is unavailable on Windows", () => {
    const r = probeSandbox(runnerWith({}), "win32");
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("Linux");
  });

  it("verifies unshare when only lo exists and is down", () => {
    const r = probeSandbox(runnerWith(unshareRun(0, "lo down\n")), "linux");
    expect(r.available).toBe(true);
    if (r.available) expect(r.adapter.kind).toBe("netns");
  });

  it("falls back to bwrap when unshare is missing, and verifies it", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(0, "lo down\n") }),
      "linux"
    );
    expect(r.available).toBe(true);
  });

  it("reports unavailable when neither candidate exists or passes", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(1, "") }),
      "linux"
    );
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("sandbox");
  });

  it("rejects extra interfaces besides lo", () => {
    const results = {
      ...unshareRun(0, "lo down\neth0 up\n"),
      ...bwrapRun(0, "lo down\neth0 up\n")
    };
    const r = probeSandbox(runnerWith(results), "linux");
    expect(r.available).toBe(false);
  });

  it("rejects lo being up", () => {
    const results = { ...unshareRun(0, "lo up\n"), ...bwrapRun(0, "lo up\n") };
    const r = probeSandbox(runnerWith(results), "linux");
    expect(r.available).toBe(false);
  });
});

describe("adapters", () => {
  it("wraps commands with unshare as an argument array", () => {
    const r = probeSandbox(runnerWith(unshareRun(0, "lo down\n")), "linux");
    if (!r.available) throw new Error("expected available");
    expect(r.adapter.wrap("echo hi")).toEqual({
      cmd: "unshare", args: ["-n", "/bin/sh", "-c", "echo hi"]
    });
  });

  it("wraps commands with bwrap when bwrap won", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(0, "lo down\n") }),
      "linux"
    );
    if (!r.available) throw new Error("expected available");
    expect(r.adapter.wrap("echo hi")).toEqual({
      cmd: "bwrap",
      args: ["--unshare-net", "--dev-bind", "/", "/", "/bin/sh", "-c", "echo hi"]
    });
  });
});

describe("probeSandboxCached", () => {
  it("runs the underlying probe once", () => {
    resetSandboxCacheForTests();
    // The cache is process-global; both calls share one probe result object.
    const a = probeSandboxCached();
    const b = probeSandboxCached();
    expect(b).toBe(a);
  });
});
