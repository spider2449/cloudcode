import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex, fuzzyFilter } from "../src/commands/fileIndex.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-idx-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src", "cli.tsx"), "");
  writeFileSync(join(root, "src", "version.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, ".env"), "");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
  return root;
}

describe("FileIndex", () => {
  it("lists files recursively with forward slashes, skipping ignored dirs and dotfiles", () => {
    const idx = new FileIndex(fixture());
    const files = idx.list().sort();
    expect(files).toEqual(["README.md", "src/cli.tsx", "src/version.ts"]);
  });

  it("caches until refresh", () => {
    const root = fixture();
    const idx = new FileIndex(root);
    idx.list();
    writeFileSync(join(root, "new.txt"), "");
    expect(idx.list()).not.toContain("new.txt");
    idx.refresh();
    expect(idx.list()).toContain("new.txt");
  });

  it("returns empty for an unreadable root", () => {
    const idx = new FileIndex(join(tmpdir(), "definitely-missing-dir-xyz"));
    expect(idx.list()).toEqual([]);
  });
});

describe("fuzzyFilter", () => {
  const paths = ["src/cli.tsx", "src/ui/App.tsx", "tests/app.test.tsx", "README.md"];

  it("matches subsequences", () => {
    expect(fuzzyFilter(paths, "sct")).toContain("src/cli.tsx");
  });

  it("ranks basename prefix matches first", () => {
    expect(fuzzyFilter(paths, "app")[0]).toBe("src/ui/App.tsx");
  });

  it("empty token returns shortest paths first, capped", () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    expect(fuzzyFilter(many, "").length).toBe(10);
  });
});
