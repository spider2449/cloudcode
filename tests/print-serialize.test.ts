import { describe, expect, it } from "vitest";
import { serializeEvent, serializeJsonRun } from "../src/print/serialize.js";
import type { EventEnvelope, RunResultMetadata } from "../src/print/events.js";

const event: EventEnvelope = {
  schemaVersion: 1, sequence: 1, timestamp: "2026-08-19T00:00:00Z",
  event: { kind: "assistant.text_delta", text: "hello" }
};
const result: RunResultMetadata = {
  durationMs: 5, provider: "local", model: "qwen", finishReason: "completed", exitCode: 0
};

describe("structured serializers", () => {
  it("serializes one parseable JSON object per stream line", () => {
    const line = serializeEvent(event);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(event);
  });

  it("serializes JSON mode as one final document", () => {
    const text = serializeJsonRun([event], result);
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, events: [event], result });
  });
});
