import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/engine/systemPrompt.js";

describe("buildSystemPrompt", () => {
  it("includes base prompt and cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sys-"));
    const p = buildSystemPrompt(dir);
    expect(p).toContain("coding agent");
    expect(p).toContain(dir);
  });
  it("appends CLAUDE.md when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sys2-"));
    writeFileSync(join(dir, "CLAUDE.md"), "Always use tabs.");
    expect(buildSystemPrompt(dir)).toContain("Always use tabs.");
  });
});
