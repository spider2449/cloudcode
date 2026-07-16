import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/agent/sessionIndex.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json");
}

describe("SessionIndex", () => {
  it("records and lists newest-first, persisted across instances", () => {
    const file = tempFile();
    const a = new SessionIndex(file);
    a.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    a.record({ id: "s2", cwd: "/p", firstMessage: "yo", timestamp: "2026-07-10T02:00:00Z", provider: "local" });
    const b = new SessionIndex(file);
    expect(b.list().map(e => e.id)).toEqual(["s2", "s1"]);
  });

  it("upserts by id", () => {
    const idx = new SessionIndex(tempFile());
    idx.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    idx.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T03:00:00Z", provider: "anthropic" });
    expect(idx.list()).toHaveLength(1);
    expect(idx.list()[0].timestamp).toBe("2026-07-10T03:00:00Z");
  });

  it("finds latest for cwd", () => {
    const idx = new SessionIndex(tempFile());
    idx.record({ id: "s1", cwd: "/a", firstMessage: "x", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    idx.record({ id: "s2", cwd: "/b", firstMessage: "y", timestamp: "2026-07-10T02:00:00Z", provider: "anthropic" });
    expect(idx.latestForCwd("/a")?.id).toBe("s1");
    expect(idx.latestForCwd("/c")).toBeUndefined();
  });
});
