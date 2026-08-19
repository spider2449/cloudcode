import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveToolFilePath } from "../src/engine/tools/filePath.js";

describe("resolveToolFilePath", () => {
  it("resolves relative paths against cwd", () => {
    expect(resolveToolFilePath("src/a.ts", "C:\\project")).toBe(resolve("C:\\project", "src/a.ts"));
  });

  it("normalizes absolute paths", () => {
    const absolute = resolve("C:\\project", "src", "..", "a.ts");
    expect(resolveToolFilePath(absolute, "C:\\other")).toBe(absolute);
  });
});
