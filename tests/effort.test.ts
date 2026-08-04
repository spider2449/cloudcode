import { describe, it, expect } from "vitest";
import {
  EFFORT_LEVELS, EFFORT_HEADROOM, isEffortLevel, clampEffortHeadroom, allowsDisabledThinking
} from "../src/engine/effort.js";

describe("effort", () => {
  it("defines the four levels", () => {
    expect(EFFORT_LEVELS).toEqual(["off", "low", "medium", "high"]);
  });
  it("maps output headroom per level", () => {
    expect(EFFORT_HEADROOM).toEqual({ low: 4096, medium: 16384, high: 32768 });
  });
  it("validates level strings", () => {
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("max")).toBe(false);
    expect(isEffortLevel(42)).toBe(false);
  });

  it("clampEffortHeadroom caps the headroom to the window minus max_tokens", () => {
    expect(clampEffortHeadroom(32768, 200_000, 8192)).toBe(32768);
    expect(clampEffortHeadroom(32768, 20_000, 8192)).toBe(20_000 - 8192);
  });

  it("clampEffortHeadroom returns 0 when the window leaves no room to spare", () => {
    expect(clampEffortHeadroom(4096, 8192, 8192)).toBe(0);
    expect(clampEffortHeadroom(4096, 4000, 8192)).toBe(0);
  });

  it("allowsDisabledThinking is false only for always-thinking models", () => {
    expect(allowsDisabledThinking("claude-sonnet-5")).toBe(true);
    expect(allowsDisabledThinking("claude-opus-5")).toBe(true);
    expect(allowsDisabledThinking("qwen2.5-coder-32b")).toBe(true);
    expect(allowsDisabledThinking("claude-fable-5")).toBe(false);
    expect(allowsDisabledThinking("claude-mythos-5")).toBe(false);
    expect(allowsDisabledThinking("claude-mythos-preview")).toBe(false);
  });

  it("allowsDisabledThinking matches provider-prefixed ids", () => {
    expect(allowsDisabledThinking("anthropic.claude-fable-5")).toBe(false);
  });
});
