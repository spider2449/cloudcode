import { describe, expect, it } from "vitest";
import { buildRepoMenuItems, clampMenuPosition } from "../src/desktop/renderer/repoContextMenu.js";

describe("repo context menu model", () => {
  it("builds a single new-session item labeled with the repo name", () => {
    expect(buildRepoMenuItems("api")).toEqual([
      { id: "new-session", label: "New session in api" },
    ]);
  });
  it("keeps coordinates when far from the viewport edge", () => {
    expect(clampMenuPosition(100, 120, 1000, 800, 200, 120)).toEqual({ left: 100, top: 120 });
  });
  it("flips inside the viewport when near the right/bottom edge", () => {
    expect(clampMenuPosition(900, 750, 1000, 800, 200, 120)).toEqual({ left: 700, top: 630 });
  });
});
