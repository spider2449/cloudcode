import { describe, expect, it } from "vitest";
import { moveProjectHighlight, projectMenuPosition } from "../src/desktop/renderer/projectMenu.js";

describe("project menu navigation", () => {
  it("moves the highlight and clamps at both ends", () => {
    expect(moveProjectHighlight(0, 1, 3)).toBe(1);
    expect(moveProjectHighlight(2, 1, 3)).toBe(2);
    expect(moveProjectHighlight(0, -1, 3)).toBe(0);
  });

  it("handles an empty project list", () => {
    expect(moveProjectHighlight(0, 1, 0)).toBe(0);
  });

  it("caps long lists below the trigger instead of extending past the viewport", () => {
    const position = projectMenuPosition({ left: 20, top: 176, bottom: 205, width: 200 }, { width: 1428, height: 870 }, 30);
    expect(position.top).toBe(211);
    expect(position.maxHeight).toBe(360);
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(862);
  });

  it("opens above a low trigger and constrains the popup in short windows", () => {
    const position = projectMenuPosition({ left: 250, top: 160, bottom: 190, width: 200 }, { width: 320, height: 220 }, 30);
    expect(position.top).toBe(8);
    expect(position.maxHeight).toBe(146);
    expect(position.left + position.width).toBeLessThanOrEqual(312);
  });
});
