import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS, EFFORT_BUDGETS, isEffortLevel, clampEffortBudget } from "../src/engine/effort.js";

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

  it("clampEffortBudget caps the budget to the window minus max_tokens", () => {
    expect(clampEffortBudget(32768, 200_000, 8192)).toBe(32768);
    expect(clampEffortBudget(32768, 20_000, 8192)).toBe(20_000 - 8192);
  });

  it("clampEffortBudget returns 0 (disable thinking) when the window is too small", () => {
    // Anything under a 1024-token budget is useless; never exceed the window.
    expect(clampEffortBudget(4096, 9000, 8192)).toBe(0);
    expect(clampEffortBudget(4096, 8192, 8192)).toBe(0);
  });
});
