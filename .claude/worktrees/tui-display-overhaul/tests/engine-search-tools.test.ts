import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../src/engine/tools/glob.js";
import { grepTool } from "../src/engine/tools/grep.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-search-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const alpha = 1;\n");
  writeFileSync(join(dir, "src", "b.txt"), "no code here\n");
  writeFileSync(join(dir, "node_modules", "pkg", "c.ts"), "export const hidden = 1;\n");
});
const ctx = () => ({ cwd: dir });

describe("globTool", () => {
  it("matches by extension recursively and skips node_modules", async () => {
    const out = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(out.content).toContain("a.ts");
    expect(out.content).not.toContain("c.ts");
    expect(out.content).not.toContain("b.txt");
  });
});

describe("grepTool", () => {
  it("finds regex matches with file and line", async () => {
    const out = await grepTool.execute({ pattern: "alpha" }, ctx());
    expect(out.content).toContain("a.ts");
    expect(out.content).toContain(":1:");
    expect(out.content).not.toContain("hidden");
  });
  it("reports no matches without error", async () => {
    const out = await grepTool.execute({ pattern: "zzz_not_there" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("No matches");
  });
});
