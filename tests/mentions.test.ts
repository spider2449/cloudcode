import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMentions, missingMentions } from "../src/commands/mentions.js";

describe("extractMentions", () => {
  it("finds tokens at line start or after whitespace", () => {
    expect(extractMentions("@a.ts fix @b/c.d.ts")).toEqual(["a.ts", "b/c.d.ts"]);
    expect(extractMentions("see\n@x.ts")).toEqual(["x.ts"]);
  });

  it("ignores emails and mid-word @", () => {
    expect(extractMentions("mail a@b.com please")).toEqual([]);
    expect(extractMentions("word@notamention")).toEqual([]);
  });

  it("deduplicates repeated paths", () => {
    expect(extractMentions("@a.ts then @a.ts again")).toEqual(["a.ts"]);
  });

  it("returns empty for no mentions", () => {
    expect(extractMentions("plain text /command")).toEqual([]);
  });
});

describe("missingMentions", () => {
  it("lists only paths that do not exist under cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentions-"));
    writeFileSync(join(cwd, "exists.ts"), "");
    mkdirSync(join(cwd, "dir"));
    const out = missingMentions("@exists.ts @nope.ts @dir", cwd);
    expect(out).toEqual(["nope.ts"]);
  });

  it("returns empty when everything exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentions-"));
    writeFileSync(join(cwd, "f.ts"), "");
    expect(missingMentions("@f.ts", cwd)).toEqual([]);
  });
});
