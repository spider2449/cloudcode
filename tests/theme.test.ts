import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadThemeName, saveThemeName } from "../src/ui/theme.js";

describe("theme presets", () => {
  it("defines dark, light, and mono", () => {
    expect(Object.keys(THEMES).sort()).toEqual(["dark", "light", "mono"]);
  });

  it("dark preserves the original colors", () => {
    expect(THEMES.dark).toEqual({
      user: "blue", accent: "cyan", muted: "gray",
      error: "red", success: "green", removed: "red", warning: "yellow",
      thinking: "magenta"
    });
  });

  it("every theme defines a thinking color distinct from its user color", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.thinking).toBeTruthy();
      expect(theme.thinking).not.toBe(theme.user);
    }
  });
});

describe("theme persistence", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "theme-"));

  it("round-trips a saved theme name", () => {
    const file = join(dir(), "theme.json");
    saveThemeName("light", file);
    expect(loadThemeName(file)).toBe("light");
  });

  it("falls back to dark when the file is missing", () => {
    expect(loadThemeName(join(dir(), "nope.json"))).toBe("dark");
  });

  it("falls back to dark when the file is corrupt", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, "not json{{");
    expect(loadThemeName(file)).toBe("dark");
  });

  it("falls back to dark for an unknown theme name", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, JSON.stringify({ name: "solarized" }));
    expect(loadThemeName(file)).toBe("dark");
  });
});
