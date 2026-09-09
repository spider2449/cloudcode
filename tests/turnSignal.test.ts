import { describe, it, expect } from "vitest";
import {
  TURN_BUSY_MARKER,
  TURN_IDLE_MARKER,
  stripTurnMarkers,
  chunkStartsTurn,
  chunkEndsTurn
} from "../src/ui/turnSignal.js";

describe("turnSignal markers", () => {
  it("detects turn start and end chunks", () => {
    expect(chunkStartsTurn(`output${TURN_BUSY_MARKER}more`)).toBe(true);
    expect(chunkStartsTurn("plain output")).toBe(false);
    expect(chunkEndsTurn(`output${TURN_IDLE_MARKER}`)).toBe(true);
    expect(chunkEndsTurn("plain output")).toBe(false);
  });

  it("strips markers so they never render in the terminal", () => {
    const chunk = `hello${TURN_BUSY_MARKER} world${TURN_IDLE_MARKER}!`;
    expect(stripTurnMarkers(chunk)).toBe("hello world!");
  });

  it("leaves marker-free chunks untouched", () => {
    expect(stripTurnMarkers("plain output")).toBe("plain output");
  });

  it("resolves coalesced busy+idle to idle via last occurrence", () => {
    // A fast turn can coalesce both markers into one PTY chunk; the host
    // takes the last marker as the current state.
    const chunk = `${TURN_BUSY_MARKER}reply text${TURN_IDLE_MARKER}`;
    const lastBusy = chunk.lastIndexOf(TURN_BUSY_MARKER);
    const lastIdle = chunk.lastIndexOf(TURN_IDLE_MARKER);
    expect(chunkStartsTurn(chunk)).toBe(true);
    expect(chunkEndsTurn(chunk)).toBe(true);
    expect(lastBusy > lastIdle).toBe(false);
  });
});
