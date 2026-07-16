import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  sanitizePath, memoryDir, memoryEntrypoint, isInsideMemoryDir, ensureMemoryDir
} from "../src/engine/memoryPaths.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccmem-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("sanitizePath", () => {
  it("replaces separators, colons and unsafe chars with dashes", () => {
    expect(sanitizePath("C:\\Users\\me\\proj")).toBe("C--Users-me-proj");
    expect(sanitizePath("/home/me/proj")).toBe("-home-me-proj");
  });
});

describe("memoryDir / memoryEntrypoint", () => {
  it("builds <base>/projects/<sanitized-cwd>/memory", () => {
    const base = tmp();
    const dir = memoryDir("C:\\work\\app", base);
    expect(dir).toBe(join(base, "projects", "C--work-app", "memory"));
    expect(memoryEntrypoint("C:\\work\\app", base)).toBe(join(dir, "MEMORY.md"));
  });

  it("rejects a non-absolute cwd instead of silently building a garbage project directory", () => {
    const base = tmp();
    // A bare CLI flag fragment (e.g. "-p", "--repo") is not a real project
    // path; sanitizePath would otherwise pass it through untouched (no
    // separators to replace) and create a bogus ~/.cloudcode/projects/-p/
    // folder. memoryDir must refuse instead of building a path for it.
    expect(() => memoryDir("-p", base)).toThrow();
    expect(() => memoryDir("--repo", base)).toThrow();
    expect(() => memoryEntrypoint("-p", base)).toThrow();
  });
});

describe("isInsideMemoryDir", () => {
  it("accepts files inside, rejects outside and traversal", () => {
    const dir = join(tmp(), "memory");
    expect(isInsideMemoryDir(join(dir, "note.md"), dir)).toBe(true);
    expect(isInsideMemoryDir(join(dir, "sub", "note.md"), dir)).toBe(true);
    expect(isInsideMemoryDir(join(dir, "..", "evil.md"), dir)).toBe(false);
    expect(isInsideMemoryDir(dir, dir)).toBe(false); // the dir itself is not a file inside it
  });
});

describe("ensureMemoryDir", () => {
  it("creates the directory recursively and is idempotent", () => {
    const dir = join(tmp(), "projects", "x", "memory");
    expect(ensureMemoryDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(ensureMemoryDir(dir)).toBe(true);
  });
});
