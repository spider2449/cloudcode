import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { THEMES as PURE_THEMES, toAppTheme } from "../src/ui/builtinThemes.js";
import { THEMES } from "../src/ui/theme.js";

describe("builtinThemes", () => {
  it("exposes the same registry as theme.js", () => {
    expect(Object.keys(PURE_THEMES).sort()).toEqual(Object.keys(THEMES).sort());
    expect(PURE_THEMES.dark).toBe(THEMES.dark);
  });
  it("maps roles like the TUI registry", () => {
    expect(toAppTheme({ primary: "#111111", text: "#222222", error: "#333333", success: "#444444", warning: "#555555" }).accent).toBe("#111111");
  });
  it("stays import-free for the browser bundle", () => {
    const source = readFileSync("src/ui/builtinThemes.ts", "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toContain("src/agent/");
  });
});
