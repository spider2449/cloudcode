import { describe, expect, it, vi } from "vitest";
import { DesktopGitService, parseDesktopGitLog, parseDesktopGitStatus } from "../src/desktop/gitService.js";
import type { GitRunner } from "../src/agent/gitReview.js";

describe("desktop Git service", () => {
  it("parses NUL-safe status, tracking and renames", () => {
    expect(parseDesktopGitStatus("## main...origin/main [ahead 2, behind 1]\0R  new name.ts\0old name.ts\0?? line\nname.ts\0")).toEqual({
      isGitRepo: true, branch: "main", upstream: "origin/main", ahead: 2, behind: 1, truncated: false, recent: [],
      files: [
        { index: "R", workingTree: " ", path: "new name.ts", originalPath: "old name.ts" },
        { index: "?", workingTree: "?", path: "line\nname.ts" }
      ]
    });
  });

  it("uses path separators and cached diff without a shell", async () => {
    const runner: GitRunner = vi.fn(async () => ({ code: 0, stdout: "diff", stderr: "", truncated: false }));
    await new DesktopGitService(runner).diff("/repo", "-odd name.ts", true);
    expect(runner).toHaveBeenCalledWith(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "--cached", "--", "-odd name.ts"], "/repo");
  });

  it("reports truncated status", async () => {
    const runner: GitRunner = async () => ({ code: 0, stdout: "## main\0 M a.ts\0", stderr: "", truncated: true });
    expect((await new DesktopGitService(runner).status("/repo")).truncated).toBe(true);
  });

  it("parses NUL-separated git log into commits", () => {
    const stdout = [
      "abc123def456\x00abc123d\x00spider\x002026-09-07\x00Fix login",
      "eeefff000111\x00eeefff0\x00spider\x002026-09-06\x00Update GUI",
      ""
    ].join("\n");
    expect(parseDesktopGitLog(stdout)).toEqual([
      { hash: "abc123def456", shortHash: "abc123d", author: "spider", date: "2026-09-07", subject: "Fix login" },
      { hash: "eeefff000111", shortHash: "eeefff0", author: "spider", date: "2026-09-06", subject: "Update GUI" }
    ]);
  });

  it("returns empty array for empty log output", () => {
    expect(parseDesktopGitLog("")).toEqual([]);
  });

  it("enriches status with lastCommit and recent from log", async () => {
    const runner: GitRunner = vi.fn(async (args) => {
      if (args[0] === "log") return { code: 0, stdout: "abc123def456\x00abc123d\x00spider\x002026-09-07\x00Fix login\n", stderr: "", truncated: false };
      return { code: 0, stdout: "## main...origin/main [ahead 1]\0", stderr: "", truncated: false };
    });
    const state = await new DesktopGitService(runner).status("/repo");
    expect(state.lastCommit?.shortHash).toBe("abc123d");
    expect(state.recent).toHaveLength(1);
    expect(state.branch).toBe("main");
    expect(state.ahead).toBe(1);
  });
});
