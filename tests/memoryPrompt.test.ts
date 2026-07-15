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
    expect(body.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    expect(body.endsWith("x")).toBe(true); // cut at newline, not mid-line padding
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
