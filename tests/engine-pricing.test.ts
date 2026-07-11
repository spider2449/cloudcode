import { describe, it, expect } from "vitest";
import { costUsd } from "../src/engine/pricing.js";

describe("costUsd", () => {
  it("prices a known model", () => {
    const c = costUsd("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(c).toBeGreaterThan(0);
  });
  it("returns undefined for unknown models", () => {
    expect(costUsd("qwen2.5-coder-32b", { input_tokens: 100, output_tokens: 100 })).toBeUndefined();
  });
});
