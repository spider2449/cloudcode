import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../src/engine/tools/read.js";
import { writeTool } from "../src/engine/tools/write.js";
import { editTool } from "../src/engine/tools/edit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cc-tools-")); });
const ctx = () => ({ cwd: dir });

describe("readTool", () => {
  it("returns numbered lines", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo");
    const out = await readTool.execute({ file_path: join(dir, "a.txt") }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("1\tone");
    expect(out.content).toContain("2\ttwo");
  });
  it("errors on missing file", async () => {
    const out = await readTool.execute({ file_path: join(dir, "nope.txt") }, ctx());
    expect(out.isError).toBe(true);
  });
});

describe("writeTool", () => {
  it("creates a file", async () => {
    const p = join(dir, "new.txt");
    const out = await writeTool.execute({ file_path: p, content: "hello" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, "utf8")).toBe("hello");
  });
});

describe("editTool", () => {
  it("replaces a unique string", async () => {
    const p = join(dir, "e.txt");
    writeFileSync(p, "foo bar foo");
    const out = await editTool.execute({ file_path: p, old_string: "bar", new_string: "baz" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, "utf8")).toBe("foo baz foo");
  });
  it("errors when old_string is not unique and replace_all is false", async () => {
    const p = join(dir, "e2.txt");
    writeFileSync(p, "foo foo");
    const out = await editTool.execute({ file_path: p, old_string: "foo", new_string: "x" }, ctx());
    expect(out.isError).toBe(true);
  });
  it("replaces all occurrences with replace_all", async () => {
    const p = join(dir, "e3.txt");
    writeFileSync(p, "foo foo");
    await editTool.execute({ file_path: p, old_string: "foo", new_string: "x", replace_all: true }, ctx());
    expect(readFileSync(p, "utf8")).toBe("x x");
  });
});
