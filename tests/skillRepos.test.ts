import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeRepoUrl, installRepo, updateRepos, removeRepo, listRepoNames,
  type GitRunner
} from "../src/agent/skillRepos.js";

describe("normalizeRepoUrl", () => {
  it("accepts a full https GitHub URL", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("accepts a URL with .git suffix", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers.git")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("accepts owner/repo shorthand", () => {
    expect(normalizeRepoUrl("obra/superpowers")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("strips a trailing slash", () => {
    expect(normalizeRepoUrl("https://github.com/obra/superpowers/")).toEqual({
      ok: true, url: "https://github.com/obra/superpowers.git", dirName: "obra--superpowers"
    });
  });

  it("rejects unsupported input", () => {
    const bad = ["", "not a url", "https://gitlab.com/a/b", "owner/repo/extra", "https://github.com/only-owner"];
    for (const input of bad) {
      const result = normalizeRepoUrl(input);
      expect(result.ok, input).toBe(false);
    }
  });
});

let reposDir: string;

beforeEach(() => { reposDir = mkdtempSync(join(tmpdir(), "skill-repos-test-")); });
afterEach(() => { rmSync(reposDir, { recursive: true, force: true }); });

function fakeGit(result: { ok: boolean; output: string }, onCall?: (args: string[], cwd: string) => void): GitRunner {
  return async (args, cwd) => { onCall?.(args, cwd); return result; };
}

function fakeRepo(name: string, withSkill = true): void {
  const dir = join(reposDir, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (withSkill) {
    mkdirSync(join(dir, "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nBody");
  }
}

describe("installRepo", () => {
  it("clones and reports the skill count", async () => {
    let cloned: string[] = [];
    const git = fakeGit({ ok: true, output: "" }, args => {
      cloned = args;
      fakeRepo("obra--superpowers"); // simulate the clone creating the dir
    });
    const msg = await installRepo("obra/superpowers", reposDir, git);
    expect(cloned.slice(0, 3)).toEqual(["clone", "--depth", "1"]);
    expect(msg).toContain("1 skill");
  });

  it("warns when the repo has no skills", async () => {
    const git = fakeGit({ ok: true, output: "" }, () => fakeRepo("obra--empty", false));
    const msg = await installRepo("obra/empty", reposDir, git);
    expect(msg.toLowerCase()).toContain("no skill");
  });

  it("rejects an already-installed repo without calling git", async () => {
    fakeRepo("obra--superpowers");
    let called = false;
    const msg = await installRepo("obra/superpowers", reposDir, fakeGit({ ok: true, output: "" }, () => { called = true; }));
    expect(called).toBe(false);
    expect(msg).toContain("already installed");
  });

  it("surfaces git failure output", async () => {
    const msg = await installRepo("obra/superpowers", reposDir, fakeGit({ ok: false, output: "fatal: repository not found" }));
    expect(msg).toContain("fatal: repository not found");
  });

  it("rejects invalid input", async () => {
    const msg = await installRepo("nonsense", reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg).toContain("Unsupported repo");
  });
});

describe("updateRepos", () => {
  it("pulls a named repo", async () => {
    fakeRepo("obra--superpowers");
    const cwds: string[] = [];
    const msg = await updateRepos("obra--superpowers", reposDir, fakeGit({ ok: true, output: "Already up to date." }, (_a, cwd) => cwds.push(cwd)));
    expect(cwds).toEqual([join(reposDir, "obra--superpowers")]);
    expect(msg).toContain("Already up to date.");
  });

  it("pulls all repos when no name is given", async () => {
    fakeRepo("a--one");
    fakeRepo("b--two");
    const cwds: string[] = [];
    await updateRepos(undefined, reposDir, fakeGit({ ok: true, output: "ok" }, (_a, cwd) => cwds.push(cwd)));
    expect(cwds.sort()).toEqual([join(reposDir, "a--one"), join(reposDir, "b--two")]);
  });

  it("lists installed names for an unknown repo", async () => {
    fakeRepo("a--one");
    const msg = await updateRepos("nope", reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg).toContain("a--one");
  });

  it("reports when nothing is installed", async () => {
    const msg = await updateRepos(undefined, reposDir, fakeGit({ ok: true, output: "" }));
    expect(msg.toLowerCase()).toContain("no skill repos");
  });
});

describe("removeRepo / listRepoNames", () => {
  it("removes an installed repo", () => {
    fakeRepo("a--one");
    const msg = removeRepo("a--one", reposDir);
    expect(existsSync(join(reposDir, "a--one"))).toBe(false);
    expect(msg).toContain("Removed");
  });

  it("lists installed names for an unknown repo", () => {
    fakeRepo("a--one");
    expect(removeRepo("nope", reposDir)).toContain("a--one");
  });

  it("listRepoNames returns directory names", () => {
    fakeRepo("a--one");
    fakeRepo("b--two");
    expect(listRepoNames(reposDir).sort()).toEqual(["a--one", "b--two"]);
    expect(listRepoNames(join(reposDir, "missing"))).toEqual([]);
  });
});
