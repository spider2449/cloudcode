import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitReview, type GitExecResult, type GitRunner } from "../src/agent/gitReview.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(stdout = "", code = 0): GitExecResult {
  return { code, stdout, stderr: code === 0 ? "" : "failed", truncated: false };
}

describe("collectGitReview", () => {
  it("uses argument arrays and disables external diff/textconv", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = vi.fn(async args => {
      calls.push(args);
      if (args[0] === "rev-parse") return result("true\n");
      return result("");
    });
    const review = await collectGitReview(process.cwd(), false, runner);
    expect(review.isGitRepo).toBe(true);
    expect(calls).toContainEqual(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"]);
    expect(calls).toContainEqual(["diff", "--no-ext-diff", "--no-textconv", "--"]);
  });

  it("staged-only mode does not request an unstaged diff", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async args => {
      calls.push(args);
      return args[0] === "rev-parse" ? result("true\n") : result("staged");
    };
    const review = await collectGitReview(process.cwd(), true, runner);
    expect(review.diff).toBe("# Staged changes\nstaged");
    expect(calls.filter(args => args[0] === "diff")).toHaveLength(1);
  });

  it("includes bounded untracked text in the default review", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-git-review-"));
    roots.push(root);
    mkdirSync(join(root, "with space"));
    writeFileSync(join(root, "with space", "new.txt"), "hello");
    const runner: GitRunner = async args => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "status") return result("? with space/new.txt\0");
      return result("");
    };
    const review = await collectGitReview(root, false, runner);
    expect(review.diff).toContain("+++ b/with space/new.txt");
    expect(review.diff).toContain("+hello");
  });

  it("returns a non-Git fallback without attempting diff", async () => {
    const runner: GitRunner = vi.fn(async () => result("", 128));
    const review = await collectGitReview(process.cwd(), false, runner);
    expect(review.isGitRepo).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });
});
