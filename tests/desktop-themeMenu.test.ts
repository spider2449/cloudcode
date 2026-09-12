import { describe, expect, it } from "vitest";
import { moveHighlight } from "../desktop/renderer/themeMenu.js";

describe("titlebar theme menu navigation", () => {
  it("moves the highlight by delta", () => {
    expect(moveHighlight(0, 1, 13)).toBe(1);
    expect(moveHighlight(5, -1, 13)).toBe(4);
  });
  it("clamps at both ends so preview never leaves the list", () => {
    expect(moveHighlight(0, -1, 13)).toBe(0);
    expect(moveHighlight(12, 1, 13)).toBe(12);
    expect(moveHighlight(0, 99, 13)).toBe(12);
  });
  it("handles an empty list without throwing", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});
