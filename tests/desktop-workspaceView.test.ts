import { describe, expect, it } from "vitest";
import { dirtyRepoCount, groupSessionsByRepo, statusGitLabel } from "../desktop/renderer/workspaceView.js";

describe("groupSessionsByRepo", () => {
  it("groups sessions under their repo and keeps empty repos", () => {
    const groups = groupSessionsByRepo(
      [{ id: "r1", name: "api" }, { id: "r2", name: "web" }],
      [{ id: "s1", firstMessage: "hi", timestamp: "2026-09-01", provider: "local", repoId: "r2" }]
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ repoId: "r1", repoName: "api" });
    expect(groups[0].sessions).toEqual([]);
    expect(groups[1].sessions.map(s => s.id)).toEqual(["s1"]);
  });
});

describe("dirtyRepoCount + statusGitLabel", () => {
  it("counts repos with files and labels the footer", () => {
    const states = { r1: { files: [{}, {}] }, r2: { files: [] }, r3: undefined };
    expect(dirtyRepoCount(states)).toBe(1);
    expect(statusGitLabel("main", 0, 2)).toBe("main · clean");
    expect(statusGitLabel("main", 2, 2)).toBe("2 repos dirty");
  });
});
