import { describe, expect, it, vi } from "vitest";
import { EventSequencer, redactStructuredError } from "../src/print/events.js";

describe("automation events", () => {
  it("uses stable monotonic envelopes and session identity", () => {
    const onEvent = vi.fn();
    const seq = new EventSequencer({ now: () => new Date("2026-08-19T01:02:03Z"), onEvent });
    const first = seq.emit({ kind: "run.started", provider: "local", model: "qwen", networkMode: "offlineStrict" });
    seq.setSessionId("session-1");
    const second = seq.emit({ kind: "assistant.text_delta", text: "hi" });
    expect(first).toMatchObject({ schemaVersion: 1, sequence: 1, timestamp: "2026-08-19T01:02:03.000Z" });
    expect(first).not.toHaveProperty("sessionId");
    expect(second).toMatchObject({ sequence: 2, sessionId: "session-1" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("redacts configured secrets and authorization header values", () => {
    const text = redactStructuredError("Authorization: Bearer abc123; upstream repeated sk-secret", ["sk-secret"]);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("sk-secret");
    expect(text.match(/\[REDACTED_SECRET\]/g)).toHaveLength(2);
  });
});
