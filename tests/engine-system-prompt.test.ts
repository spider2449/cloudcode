import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/engine/systemPrompt.js";
import { sanitizePath, memoryDir } from "../src/engine/memoryPaths.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cc-sys-tmp-"));
}

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

describe("user CLOUDCODE.md and memory section", () => {
  it("includes user-level CLOUDCODE.md from the config base", () => {
    const base = tmp();
    writeFileSync(join(base, "CLOUDCODE.md"), "always answer in haiku");
    const p = buildSystemPrompt(tmp(), { configBase: base });
    expect(p).toContain("# User instructions (CLOUDCODE.md)");
    expect(p).toContain("always answer in haiku");
  });
  it("includes the memory section with MEMORY.md content", () => {
    const base = tmp();
    const cwd = tmp();
    mkdirSync(join(base, "projects", sanitizePath(cwd), "memory"), { recursive: true });
    writeFileSync(join(base, "projects", sanitizePath(cwd), "memory", "MEMORY.md"), "- [A](a.md) — hook");
    const p = buildSystemPrompt(cwd, { configBase: base });
    expect(p).toContain("# Auto memory");
    expect(p).toContain("- [A](a.md) — hook");
  });
  it("omits the memory section when autoMemory is false", () => {
    const p = buildSystemPrompt(tmp(), { configBase: tmp(), autoMemory: false });
    expect(p).not.toContain("# Auto memory");
  });
  it("does not create the memory directory just from building the prompt", () => {
    const base = tmp();
    const cwd = tmp();
    const p = buildSystemPrompt(cwd, { configBase: base });
    expect(p).toContain("# Auto memory");
    expect(existsSync(memoryDir(cwd, base))).toBe(false);
  });
});
