import { describe, expect, it } from "vitest";
import { parseDuration, parsePositiveInteger, parsePositiveNumber, parseRunLimits } from "../src/print/runLimits.js";
import { RunLimitConfigurationError, validateRunLimits } from "../src/engine/runLimits.js";

describe("run limit parsers", () => {
  it("parses strict positive values and durations", () => {
    expect(parsePositiveInteger("8", "--max-turns")).toBe(8);
    expect(parsePositiveNumber("1.50", "--max-cost-usd")).toBe(1.5);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("2.5m")).toBe(150_000);
    expect(parseRunLimits({ maxTurns: "2", timeout: "1h", maxCostUsd: ".5" }))
      .toEqual({ maxTurns: 2, timeoutMs: 3_600_000, maxCostUsd: 0.5 });
  });

  it("rejects zero, signs, whitespace, fractions of milliseconds, and junk", () => {
    for (const value of ["0", "-1", "+1", " 1", "1.2"]) {
      expect(() => parsePositiveInteger(value, "--max-turns"), value).toThrow();
    }
    for (const value of ["0", "-1", "1e3", "NaN", " 1"]) {
      expect(() => parsePositiveNumber(value, "--max-cost-usd"), value).toThrow();
    }
    for (const value of ["10", "0s", "1d", "0.1ms", " 1s"]) expect(() => parseDuration(value), value).toThrow();
  });

  it("rejects a cost cap when model pricing is unknown", () => {
    expect(() => validateRunLimits({ maxCostUsd: 1 }, "mystery-model"))
      .toThrow(RunLimitConfigurationError);
    expect(() => validateRunLimits({ maxCostUsd: 1 }, "claude-sonnet-5")).not.toThrow();
  });
});
