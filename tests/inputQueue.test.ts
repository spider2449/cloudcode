import { describe, it, expect } from "vitest";
import { InputQueue } from "../src/ui/inputQueue.js";

describe("InputQueue", () => {
  it("is empty initially and reports its size", () => {
    const q = new InputQueue();
    expect(q.size).toBe(0);
  });

  it("drains FIFO only when idle, one message per drain", () => {
    const q = new InputQueue();
    const sent: string[] = [];
    q.enqueue("first");
    q.enqueue("second");
    expect(q.size).toBe(2);
    q.drainIfIdle(() => true, t => sent.push(t));
    expect(sent).toEqual(["first"]);
    expect(q.size).toBe(1);
  });

  it("does not drain when not idle", () => {
    const q = new InputQueue();
    const sent: string[] = [];
    q.enqueue("first");
    q.drainIfIdle(() => false, t => sent.push(t));
    expect(sent).toEqual([]);
    expect(q.size).toBe(1);
  });

  it("does nothing when idle but empty", () => {
    const q = new InputQueue();
    const sent: string[] = [];
    q.drainIfIdle(() => true, t => sent.push(t));
    expect(sent).toEqual([]);
  });
});
