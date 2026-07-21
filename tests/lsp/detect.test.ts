import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage, findRoot, commandExists } from "../../src/engine/lsp/detect.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

describe("detectLanguage", () => {
  it("matches by extension", () => {
    expect(detectLanguage("/a/b/foo.ts", DEFAULT_SERVERS)).toBe("typescript");
    expect(detectLanguage("/a/b/foo.py", DEFAULT_SERVERS)).toBe("python");
    expect(detectLanguage("/a/b/foo.txt", DEFAULT_SERVERS)).toBeUndefined();
  });
});

describe("findRoot", () => {
  it("walks up to the nearest marker", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    writeFileSync(join(root, "go.mod"), "module x", "utf8");
    const nested = join(root, "pkg", "sub");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "main.go");
    writeFileSync(file, "package main", "utf8");
    expect(findRoot(file, ["go.mod"], "/fallback")).toBe(root);
  });

  it("returns the fallback when no marker is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "noroot-"));
    const file = join(dir, "main.go");
    writeFileSync(file, "package main", "utf8");
    expect(findRoot(file, ["go.mod"], "/fallback")).toBe("/fallback");
  });
});

describe("commandExists", () => {
  it("finds node on PATH and rejects a bogus command", () => {
    expect(commandExists("node")).toBe(true);
    expect(commandExists("definitely-not-a-real-command-xyz")).toBe(false);
  });
});
