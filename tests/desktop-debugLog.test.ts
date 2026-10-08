import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopDebugLog, desktopDebugDirectory, diagnosticError } from "../src/desktop/debugLog.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cloudcode-debug-"));
  directories.push(directory);
  return directory;
}
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("desktop diagnostics", () => {
  it("uses the environment temporary directory instead of userData", () => {
    const directory = temporaryDirectory();
    vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", directory);
    expect(desktopDebugDirectory()).toBe(join(directory, "cloudcode", "logs"));
  });
  it("persists structured termination metadata with timestamp and process identity", () => {
    const log = new DesktopDebugLog(temporaryDirectory());
    log.write("renderer-gone", { reason: "oom", exitCode: 137 });
    const record = JSON.parse(readFileSync(log.file, "utf8"));
    expect(record).toMatchObject({ event: "renderer-gone", reason: "oom", exitCode: 137, pid: process.pid });
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });
  it("keeps at most three bounded files across restarts", () => {
    const directory = temporaryDirectory();
    for (let i = 0; i < 12; i++) new DesktopDebugLog(directory, true, 160).write("heartbeat", { index: i });
    expect(readdirSync(directory)).toHaveLength(3);
    for (const file of readdirSync(directory)) expect(readFileSync(join(directory, file)).length).toBeLessThanOrEqual(160);
    const lines = readFileSync(join(directory, "desktop-debug.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}").index).toBe(11);
  });
  it("does not write when disabled and tolerates an unavailable directory", () => {
    const directory = temporaryDirectory();
    new DesktopDebugLog(directory, false).write("startup");
    expect(readdirSync(directory)).toHaveLength(0);
    const blocked = join(directory, "file");
    writeFileSync(blocked, "blocked");
    expect(() => new DesktopDebugLog(blocked).write("startup")).not.toThrow();
  });
  it("excludes error messages and stacks containing application secrets", () => {
    const error = Object.assign(new Error("secret prompt token=private"), { code: "EPIPE" });
    expect(diagnosticError(error)).toEqual({ errorName: "Error", errorCode: "EPIPE" });
    expect(JSON.stringify(diagnosticError(error))).not.toContain("private");
    expect(diagnosticError("secret")).toEqual({ errorName: "UnknownError" });
  });
});
