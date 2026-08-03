import { describe, it, expect } from "vitest";
import { UsageTracker, type UsageTrackerDeps } from "../src/ui/usageTracker.js";

function tracker(overrides: Partial<UsageTrackerDeps> = {}) {
  const notices: string[] = [];
  const errors: string[] = [];
  const deps: UsageTrackerDeps = {
    contextWindow: () => 1000,
    compact: async () => undefined,
    notice: t => { notices.push(t); },
    onError: t => { errors.push(t); },
    recompute: () => {},
    ...overrides
  };
  return { usage: new UsageTracker(deps), notices, errors };
}

describe("UsageTracker", () => {
  it("reports the current context size rather than a lifetime sum", () => {
    const { usage } = tracker();
    usage.applyTurnUsage({ input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 });
    expect(usage.tokens).toBe(160);
    expect(usage.contextPct).toBe(15); // 150 input / 1000
    // A second turn resends the whole history: the new figure replaces the old.
    usage.applyTurnUsage({ input_tokens: 200, output_tokens: 20 });
    expect(usage.tokens).toBe(220);
    expect(usage.contextPct).toBe(20);
  });

  it("accumulates cost across turns", () => {
    const { usage } = tracker();
    usage.addCost(0.01);
    usage.addCost(0.02);
    expect(usage.cost).toBeCloseTo(0.03);
  });

  it("auto-compacts once the context window passes the threshold", async () => {
    let compacted = 0;
    const { usage, notices } = tracker({
      compact: async () => { compacted += 1; return 120; }
    });
    usage.applyTurnUsage({ input_tokens: 850, output_tokens: 10 });
    await Promise.resolve();
    await Promise.resolve();
    expect(compacted).toBe(1);
    expect(usage.tokens).toBe(120);
    expect(usage.contextPct).toBe(12);
    expect(notices).toContain("Context was getting full — compacted automatically.");
    expect(usage.compactPct).toBeUndefined();
  });

  it("does not start a second auto-compact while one is in flight", async () => {
    let compacted = 0;
    let release: (v: number) => void = () => {};
    const { usage } = tracker({
      compact: () => { compacted += 1; return new Promise<number>(r => { release = r; }); }
    });
    usage.applyTurnUsage({ input_tokens: 900, output_tokens: 0 });
    usage.applyTurnUsage({ input_tokens: 950, output_tokens: 0 });
    expect(compacted).toBe(1);
    release(100);
    await Promise.resolve();
  });

  it("surfaces a failed auto-compact and clears the progress indicator", async () => {
    const { usage, errors } = tracker({
      compact: async () => { throw new Error("boom"); }
    });
    usage.applyTurnUsage({ input_tokens: 900, output_tokens: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors[0]).toBe("Auto-compact failed: boom");
    expect(usage.compactPct).toBeUndefined();
  });

  it("clears context figures for a new session but keeps the session cost", () => {
    const { usage } = tracker();
    usage.addCost(0.05);
    usage.applyTurnUsage({ input_tokens: 100, output_tokens: 10 });
    usage.resetForNewSession();
    expect(usage.tokens).toBe(0);
    expect(usage.contextPct).toBeUndefined();
    expect(usage.cost).toBeCloseTo(0.05);
  });
});
