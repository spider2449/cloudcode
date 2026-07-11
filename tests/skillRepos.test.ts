import { describe, it, expect } from "vitest";
import { normalizeRepoUrl } from "../src/agent/skillRepos.js";

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
