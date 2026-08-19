import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkAudit } from "../src/agent/networkAudit.js";

describe("NetworkAudit", () => {
  it("stores bounded secret-free JSONL records", () => {
    const dir = mkdtempSync(join(tmpdir(), "network-audit-"));
    const filePath = join(dir, "audit", "network.jsonl");
    const audit = new NetworkAudit({ filePath, maxRecords: 2, now: () => new Date("2026-08-19T00:00:00Z") });
    for (const destinationHost of ["one.example", "two.example", "three.example"]) {
      audit.record({ capability: "provider", destinationHost, mode: "providerOnly", allowed: true });
    }
    const text = readFileSync(filePath, "utf8");
    const lines = text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0].destinationHost).toBe("two.example");
    expect(lines[1]).toEqual({
      schemaVersion: 1, timestamp: "2026-08-19T00:00:00.000Z", capability: "provider",
      destinationHost: "three.example", mode: "providerOnly", allowed: true
    });
    expect(text).not.toMatch(/token|authorization|query|prompt|path|body/i);
  });
});
