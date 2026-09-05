import { describe, expect, it } from "vitest";
import { requireBranchName, requireDimension, requirePaths, requireString } from "../src/desktop/ipcContract.js";

describe("desktop IPC validation", () => {
  it("rejects malformed terminal values", () => {
    expect(() => requireString({}, "workspace ID")).toThrow("Invalid workspace ID");
    expect(() => requireDimension(Number.NaN, "columns")).toThrow("Invalid columns");
  });
  it("rejects option-like and multiline branch names", () => {
    expect(() => requireBranchName("-f")).toThrow("Invalid branch name");
    expect(() => requireBranchName("main\nother")).toThrow("Invalid branch name");
  });
  it("requires a bounded non-empty path list", () => {
    expect(requirePaths(["src/a.ts"])).toEqual(["src/a.ts"]);
    expect(() => requirePaths([])).toThrow("Invalid Git paths");
  });
});
