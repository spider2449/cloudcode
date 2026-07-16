import { describe, it, expect } from "vitest";
import { visibleWindow } from "../src/ui/SuggestionMenu.js";

describe("visibleWindow", () => {
  it("shows everything when it fits", () => {
    expect(visibleWindow(5, 2)).toEqual({ start: 0, end: 5 });
  });

  it("scrolls to keep the selection visible", () => {
    expect(visibleWindow(20, 0)).toEqual({ start: 0, end: 8 });
    expect(visibleWindow(20, 10)).toEqual({ start: 3, end: 11 });
    expect(visibleWindow(20, 19)).toEqual({ start: 12, end: 20 });
  });
});
