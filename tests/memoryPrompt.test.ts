import { describe, it, expect } from "vitest";
import {
  truncateEntrypoint, buildMemoryPrompt, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES
} from "../src/engine/memoryPrompt.js";

describe("truncateEntrypoint", () => {
  it("passes short content through untouched", () => {
    const r = truncateEntrypoint("- [A](a.md) — hook\n");
    expect(r.wasTruncated).toBe(false);
    expect(r.content).toBe("- [A](a.md) — hook");
  });
  it("truncates past the line cap with a warning", () => {
    const raw = Array.from({ length: 300 }, (_, i) => `- line ${i}`).join("\n");
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    const lines = r.content.split("\n");
    expect(lines.filter(l => l.startsWith("- line")).length).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.content).toContain("WARNING");
  });
  it("truncates past the byte cap at a newline boundary", () => {
    const raw = Array.from({ length: 150 }, () => "x".repeat(400)).join("\n"); // 150 lines, ~60KB
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    const body = r.content.slice(0, r.content.indexOf("\n\n> WARNING"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    expect(body.endsWith("x")).toBe(true); // cut at newline, not mid-line padding
  });
  it("correctly measures UTF-8 byte count for multi-byte characters", () => {
    // Each CJK character is ~3 bytes in UTF-8; "你好" = 6 bytes
    // Create a string with enough repetitions to exceed 25_000 bytes but still under line cap
    const cjkChar = "你"; // 3 bytes in UTF-8
    const count = Math.floor(MAX_ENTRYPOINT_BYTES / 3) + 100; // ~8500 chars = ~25500 bytes
    const raw = Array.from({ length: count }, () => cjkChar).join("");
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    const body = r.content.slice(0, r.content.indexOf("\n\n> WARNING"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
  });
  it("truncates when exceeding both line and byte caps simultaneously", () => {
    // Create content that exceeds both: >200 lines AND >25_000 bytes
    // Use lines of sufficient length to hit byte cap before line cap alone would
    const longLine = "x".repeat(200); // 200 bytes per line
    const raw = Array.from({ length: 250 }, () => longLine).join("\n");
    // 250 lines * 200 bytes + newlines = 50_000+ bytes, exceeds both caps
    const r = truncateEntrypoint(raw);
    expect(r.wasTruncated).toBe(true);
    expect(r.content).toContain("lines and");
    expect(r.content).toContain("bytes");
    const body = r.content.slice(0, r.content.indexOf("\n\n> WARNING"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
  });
});

describe("buildMemoryPrompt", () => {
  it("contains the directory, taxonomy, protocol, and index content", () => {
    const p = buildMemoryPrompt("D:\\mem\\dir", "- [A](a.md) — hook");
    expect(p).toContain("D:\\mem\\dir");
    for (const t of ["user", "feedback", "project", "reference"]) expect(p).toContain(`**${t}**`);
    expect(p).toContain("What NOT to save");
    expect(p).toContain("MEMORY.md");
    expect(p).toContain("- [A](a.md) — hook");
  });
  it("notes an empty index", () => {
    expect(buildMemoryPrompt("D:\\mem\\dir", "")).toContain("currently empty");
  });
});
