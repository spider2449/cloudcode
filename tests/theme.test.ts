import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadThemeName, saveThemeName, toAppTheme } from "../src/ui/theme.js";

const HEX = /^#[0-9a-f]{6}$/;
const ROLES = ["user", "accent", "muted", "error", "success", "removed", "warning", "thinking"] as const;

describe("built-in themes", () => {
  it("includes the original three", () => {
    for (const name of ["dark", "light", "mono"]) expect(THEMES[name]).toBeDefined();
  });

  it("every theme resolves all roles to hex colors", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const role of ROLES) {
        expect(theme[role], `${name}.${role}`).toMatch(HEX);
      }
    }
  });

  it("every theme defines a thinking color distinct from its user color", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.thinking).toBeTruthy();
      expect(theme.thinking).not.toBe(theme.user);
    }
  });
});

describe("toAppTheme role mapping", () => {
  const base = {
    primary: "#010101", secondary: "#020202", accent: "#030303", text: "#040404",
    textMuted: "#050505", error: "#060606", success: "#070707", warning: "#080808"
  };
  it("maps opencode roles onto app roles with fallbacks", () => {
    const t = toAppTheme({ ...base, diffRemoved: "#090909", thinking: "#0a0a0a" });
    expect(t.user).toBe("#020202");        // secondary
    expect(t.accent).toBe("#030303");
    expect(t.muted).toBe("#050505");       // textMuted
    expect(t.removed).toBe("#090909");     // diffRemoved
    expect(t.thinking).toBe("#080808");    // explicit key wins, darkened by 0.8
  });
  it("falls back when optional roles are missing", () => {
    const t = toAppTheme(base);
    expect(t.removed).toBe("#060606");     // error
    expect(t.thinking).toBe("#040404");    // textMuted, darkened by 0.8
  });
  it("keeps extra resolved keys accessible", () => {
    const t = toAppTheme({ ...base, diffAdded: "#0b0b0b" });
    expect(t.diffAdded).toBe("#0b0b0b");
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
    writeFileSync(file, JSON.stringify({ name: "does-not-exist" }));
    expect(loadThemeName(file)).toBe("dark");
  });
});
