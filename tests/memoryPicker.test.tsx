import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryOptions } from "../src/ui/MemoryPicker.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccpick-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("buildMemoryOptions", () => {
  it("marks missing files (new) and includes the memory folder", () => {
    const base = tmp();
    const cwd = tmp();
    const opts = buildMemoryOptions(cwd, base);
    expect(opts[0]).toMatchObject({ label: "User memory (new)", path: join(base, "CLAUDE.md"), kind: "file" });
    expect(opts[1]).toMatchObject({ label: "Project memory (new)", path: join(cwd, "CLAUDE.md"), kind: "file" });
    expect(opts[2].kind).toBe("folder");
  });
  it("drops the (new) suffix for existing files", () => {
    const base = tmp();
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    const opts = buildMemoryOptions(cwd, base);
    expect(opts[1].label).toBe("Project memory");
  });
});
