import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResizeGuard } from "../src/ui/resizeGuard.js";

function makeDeps() {
  const writes: string[] = [];
  let running = true;
  let recomputed = 0;
  return {
    writes,
    recomputed: () => recomputed,
    setRunning(value: boolean) { running = value; },
    guardDeps: {
      isRunning: () => running,
      write(text: string) { writes.push(text); },
      invalidateRenderer() { /* tracked via write */ },
      recommitBuffer() { /* no-op */ },
      recompute() { recomputed += 1; }
    }
  };
}

describe("ResizeGuard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("repaints immediately and once more after the size settles", () => {
    const { guardDeps, recomputed, writes } = makeDeps();
    const guard = new ResizeGuard(guardDeps);
    guard.handleResize();
    expect(recomputed()).toBe(1);
    vi.advanceTimersByTime(150);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("\u001b[2J");
    expect(recomputed()).toBe(2);
    guard.dispose();
  });

  it("debounces resize storms into a single full repaint", () => {
    const { guardDeps, writes } = makeDeps();
    const guard = new ResizeGuard(guardDeps);
    guard.handleResize();
    guard.handleResize();
    guard.handleResize();
    vi.advanceTimersByTime(150);
    expect(writes.length).toBe(1);
    guard.dispose();
  });

  it("is fully inert after stop even if a resize arrives later", () => {
    const { guardDeps, setRunning, recomputed, writes } = makeDeps();
    const guard = new ResizeGuard(guardDeps);
    setRunning(false);
    guard.handleResize();
    expect(recomputed()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(writes.length).toBe(0);
    guard.dispose();
  });

  it("dispose cancels a pending settled-size reprint", () => {
    const { guardDeps, writes } = makeDeps();
    const guard = new ResizeGuard(guardDeps);
    guard.handleResize();
    guard.dispose();
    vi.advanceTimersByTime(300);
    expect(writes.length).toBe(0);
  });
});
