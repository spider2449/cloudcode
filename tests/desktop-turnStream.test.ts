import { describe, it, expect } from "vitest";
import { TurnStream } from "../src/desktop/turnStream.js";
import { TURN_BUSY_MARKER, TURN_IDLE_MARKER } from "../src/ui/turnSignal.js";

describe("TurnStream", () => {
  it("passes marker-free output through and stays idle", () => {
    const stream = new TurnStream();
    expect(stream.push("hello world")).toBe("hello world");
    expect(stream.busy).toBe(false);
  });

  it("detects an intact busy marker and strips it from visible output", () => {
    const stream = new TurnStream();
    expect(stream.push(`frame${TURN_BUSY_MARKER}more`)).toBe("framemore");
    expect(stream.busy).toBe(true);
  });

  it("resolves coalesced busy+idle to idle via last occurrence", () => {
    const stream = new TurnStream();
    expect(stream.push(`${TURN_BUSY_MARKER}reply${TURN_IDLE_MARKER}`)).toBe("reply");
    expect(stream.busy).toBe(false);
  });

  it("detects a marker split at any chunk boundary", () => {
    for (let at = 1; at < TURN_BUSY_MARKER.length; at++) {
      const stream = new TurnStream();
      const head = TURN_BUSY_MARKER.slice(0, at);
      const tail = TURN_BUSY_MARKER.slice(at);
      expect(stream.push(`a${head}`)).toBe("a");
      expect(stream.busy).toBe(false);
      expect(stream.push(`${tail}b`)).toBe("b");
      expect(stream.busy).toBe(true);
    }
  });

  it("holds back only a genuine partial marker, not ordinary text", () => {
    const stream = new TurnStream();
    // Ends with ESC but not a marker prefix: flushed immediately.
    expect(stream.push("text\x1b[0m")).toBe("text\x1b[0m");
    expect(stream.push("next")).toBe("next");
  });

  it("recovers when a held-back prefix turns out not to be a marker", () => {
    const stream = new TurnStream();
    const prefix = TURN_BUSY_MARKER.slice(0, 5); // "\x1b]777" — also a prefix of idle
    expect(stream.push(`a${prefix}`)).toBe("a");
    expect(stream.push("XYZ")).toBe(`${prefix}XYZ`);
    expect(stream.busy).toBe(false);
  });

  it("reset clears held bytes and the busy flag", () => {
    const stream = new TurnStream();
    stream.push(`x${TURN_BUSY_MARKER}`);
    expect(stream.busy).toBe(true);
    stream.reset();
    expect(stream.busy).toBe(false);
    expect(stream.push("clean")).toBe("clean");
  });
});
