import { describe, expect, it } from "vitest";
import { formatRelativeTime, gitFilePaths, gitStatusLabel } from "../desktop/renderer/gitPanel.js";

describe("git status labels", () => {
  it("maps index/working-tree codes to badge letters", () => {
    expect(gitStatusLabel("?")).toBe("A");
    expect(gitStatusLabel("A")).toBe("A");
    expect(gitStatusLabel("D")).toBe("D");
    expect(gitStatusLabel("R")).toBe("R");
    expect(gitStatusLabel("U")).toBe("U");
    expect(gitStatusLabel("M")).toBe("M");
    expect(gitStatusLabel(" ")).toBe("M");
  });
});

describe("git file paths", () => {
  it("includes the original path for renames", () => {
    expect(gitFilePaths({ path: "new.ts", originalPath: "old.ts", index: "R", workingTree: " " })).toEqual(["new.ts", "old.ts"]);
  });
  it("returns just the path otherwise", () => {
    expect(gitFilePaths({ path: "a.ts", index: "M", workingTree: "M" })).toEqual(["a.ts"]);
  });
});

describe("relative fetch time", () => {
  it("formats recency without throwing on missing values", () => {
    expect(formatRelativeTime(undefined)).toBe("never fetched yet");
    expect(formatRelativeTime(Date.now())).toBe("just now");
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5 min ago");
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe("3 h ago");
  });
});
