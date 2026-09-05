import { describe, expect, it, vi } from "vitest";
import { DesktopGitService, parseDesktopGitStatus } from "../src/desktop/gitService.js";
import type { GitRunner } from "../src/agent/gitReview.js";

describe("desktop Git service", () => {
  it("parses NUL-safe status, tracking and renames", () => {
    expect(parseDesktopGitStatus("## main...origin/main [ahead 2, behind 1]\0R  new name.ts\0old name.ts\0?? line\nname.ts\0")).toEqual({
      isGitRepo: true, branch: "main", upstream: "origin/main", ahead: 2, behind: 1, truncated: false,
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
});
