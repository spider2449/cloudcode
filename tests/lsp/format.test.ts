import { describe, it, expect } from "vitest";
import { formatLocations, formatHover, formatDiagnosticsBlock } from "../../src/engine/lsp/format.js";

describe("formatLocations", () => {
  it("renders 1-based file:line:col and caps", () => {
    const out = formatLocations(
      [{ uri: "file:///a/b.ts", line: 4, column: 2 }, { uri: "file:///a/c.ts", line: 0, column: 0 }],
      1
    );
    expect(out.split("\n")[0]).toMatch(/b\.ts:5:3$/);
    expect(out).toContain("(1 more)");
  });
});

describe("formatHover", () => {
  it("reads a markdown value object", () => {
    expect(formatHover({ contents: { kind: "markdown", value: "const x: number" } })).toBe("const x: number");
  });
  it("reads a plain string", () => {
    expect(formatHover({ contents: "hello" })).toBe("hello");
  });
  it("joins an array of parts", () => {
    expect(formatHover({ contents: ["a", { value: "b" }] })).toBe("a\nb");
  });
});

describe("formatDiagnosticsBlock", () => {
  it("returns empty string when there are no diagnostics", () => {
    expect(formatDiagnosticsBlock("a.ts", [], 10)).toBe("");
  });
  it("orders errors before warnings and caps with a footer", () => {
    const out = formatDiagnosticsBlock("a.ts", [
      { line: 19, column: 0, severity: 2, message: "warn", code: "W1" },
      { line: 11, column: 4, severity: 1, message: "boom", code: "E1" }
    ], 1);
    const lines = out.split("\n");
    expect(lines[0]).toBe("--- diagnostics (edited file) ---");
    expect(lines[1]).toBe("a.ts:12:5 error E1: boom");
    expect(out).toContain("(2 issues)");
  });
  it("uses a custom header when provided", () => {
    const out = formatDiagnosticsBlock("a.ts", [
      { line: 0, column: 0, severity: 1, message: "boom" }
    ], 10, "--- diagnostics ---");
    expect(out.split("\n")[0]).toBe("--- diagnostics ---");
  });
});
