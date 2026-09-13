import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GUI_SLASH_NAMES } from "../src/commands/guiSlashNames.js";
import { buildRegistry } from "../src/commands/builtins.js";

describe("guiSlashNames", () => {
  it("matches the desktop-visible registry keys", () => {
    const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
    expect([...GUI_SLASH_NAMES].sort()).toEqual([...registry.keys()].sort());
  });
  it("stays import-free for the browser bundle", () => {
    expect(readFileSync("src/commands/guiSlashNames.ts", "utf8")).not.toMatch(/from ["']node:/);
  });
});
