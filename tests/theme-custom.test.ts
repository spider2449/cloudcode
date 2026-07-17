import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadCustomThemes } from "../src/ui/theme.js";

const themeDir = () => mkdtempSync(join(tmpdir(), "cc-themes-"));

const VALID = JSON.stringify({
  defs: { pop: "#12ab34" },
  theme: { primary: "pop", secondary: "#000001", accent: "pop", text: "#cccccc",
           textMuted: "#777777", error: "#ff0000", success: "#00ff00", warning: "#ffff00" }
});

describe("loadCustomThemes", () => {
  it("returns no warnings for a missing directory", () => {
    expect(loadCustomThemes(join(themeDir(), "nope"))).toEqual([]);
  });

  it("registers a valid custom theme by filename", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "mytheme.json"), VALID);
    expect(loadCustomThemes(dir)).toEqual([]);
    expect(THEMES.mytheme.accent).toBe("#12ab34");
  });

  it("lets a custom theme override a built-in of the same name", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "dark.json"), VALID);
    loadCustomThemes(dir);
    expect(THEMES.dark.accent).toBe("#12ab34");
  });

  it("skips invalid JSON with a warning and keeps loading others", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "broken.json"), "not json{{");
    writeFileSync(join(dir, "good.json"), VALID);
    const warnings = loadCustomThemes(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken.json");
    expect(THEMES.good).toBeDefined();
    expect(THEMES.broken).toBeUndefined();
  });

  it("skips themes with unresolvable references with a warning", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "dangling.json"), JSON.stringify({ theme: { primary: "ghost" } }));
    const warnings = loadCustomThemes(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dangling.json");
  });

  it("ignores non-json files", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "readme.txt"), "hi");
    expect(loadCustomThemes(dir)).toEqual([]);
  });
});
