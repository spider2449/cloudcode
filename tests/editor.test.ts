import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFile } from "../src/commands/editor.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccedit-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("ensureFile", () => {
  it("creates the file with empty content when missing", () => {
    const dir = tmp();
    const path = join(dir, "CLAUDE.md");
    ensureFile(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("does not touch existing content (wx flag preserves it, EEXIST caught)", () => {
    const dir = tmp();
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "existing content");
    ensureFile(path);
    expect(readFileSync(path, "utf8")).toBe("existing content");
  });
});
