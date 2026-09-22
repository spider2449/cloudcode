import { describe, expect, it } from "vitest";
import { moveProjectHighlight } from "../src/desktop/renderer/projectMenu.js";

describe("project menu navigation", () => {
  it("moves the highlight and clamps at both ends", () => {
    expect(moveProjectHighlight(0, 1, 3)).toBe(1);
    expect(moveProjectHighlight(2, 1, 3)).toBe(2);
    expect(moveProjectHighlight(0, -1, 3)).toBe(0);
  });

  it("handles an empty project list", () => {
    expect(moveProjectHighlight(0, 1, 0)).toBe(0);
  });
});
