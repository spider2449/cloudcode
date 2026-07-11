import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveProjectPath, recentProjects } from "../src/commands/projectPath.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";

function entry(cwd: string, timestamp: string): SessionEntry {
  return { id: cwd + timestamp, cwd, firstMessage: "hi", timestamp, provider: "anthropic" };
}

describe("resolveProjectPath", () => {
  const base = mkdtempSync(join(tmpdir(), "cloudcode-proj-"));

  it("resolves a relative path against cwd", () => {
    mkdirSync(join(base, "sub"));
    expect(resolveProjectPath("sub", base)).toEqual({ ok: true, path: resolve(base, "sub") });
  });

  it("accepts an absolute directory path", () => {
    expect(resolveProjectPath(base, "C:\\")).toEqual({ ok: true, path: resolve(base) });
  });

  it("expands ~ to the home directory", () => {
    const r = resolveProjectPath("~", base);
    expect(r).toEqual({ ok: true, path: resolve(homedir()) });
  });

  it("rejects a missing path", () => {
    const r = resolveProjectPath(join(base, "nope"), base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Not a directory");
  });

  it("rejects a file path", () => {
    const file = join(base, "file.txt");
    writeFileSync(file, "x");
    const r = resolveProjectPath(file, base);
    expect(r.ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(resolveProjectPath("", base).ok).toBe(false);
  });
});

describe("recentProjects", () => {
  it("dedupes cwds, most recent first, current cwd first", () => {
    const entries = [
      entry("/a", "2026-01-01T00:00:00Z"),
      entry("/b", "2026-01-03T00:00:00Z"),
      entry("/a", "2026-01-02T00:00:00Z"),
      entry("/cur", "2026-01-01T12:00:00Z")
    ];
    expect(recentProjects(entries, "/cur")).toEqual(["/cur", "/b", "/a"]);
  });

  it("includes current cwd even with no sessions", () => {
    expect(recentProjects([], "/cur")).toEqual(["/cur"]);
  });
});
