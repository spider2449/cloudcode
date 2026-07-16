import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../src/agent/asyncQueue.js";

describe("AsyncQueue", () => {
  it("yields pushed items in order and ends on close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    setTimeout(() => { q.push(3); q.close(); }, 10);
    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });
});
