import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS, EFFORT_BUDGETS, isEffortLevel } from "../src/engine/effort.js";

describe("effort", () => {
  it("defines the four levels", () => {
    expect(EFFORT_LEVELS).toEqual(["off", "low", "medium", "high"]);
  });
  it("maps budgets per spec", () => {
    expect(EFFORT_BUDGETS).toEqual({ low: 4096, medium: 16384, high: 32768 });
  });
  it("validates level strings", () => {
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("max")).toBe(false);
    expect(isEffortLevel(42)).toBe(false);
  });
});
