import { describe, it, expect } from "vitest";
import { ansiToHex, resolveThemeJson, type ThemeJson } from "../src/ui/themeJson.js";

describe("ansiToHex", () => {
  it("maps the standard 16 colors", () => {
    expect(ansiToHex(0)).toBe("#000000");
    expect(ansiToHex(1)).toBe("#800000");
    expect(ansiToHex(4)).toBe("#000080");
    expect(ansiToHex(7)).toBe("#c0c0c0");
    expect(ansiToHex(9)).toBe("#ff0000");
    expect(ansiToHex(15)).toBe("#ffffff");
  });
  it("maps the 6x6x6 cube", () => {
    expect(ansiToHex(16)).toBe("#000000");   // 0,0,0
    expect(ansiToHex(196)).toBe("#ff0000");  // 5,0,0
    expect(ansiToHex(231)).toBe("#ffffff");  // 5,5,5
    expect(ansiToHex(110)).toBe("#87afd7");  // 2,3,4 -> 135,175,215
  });
  it("maps the grayscale ramp", () => {
    expect(ansiToHex(232)).toBe("#080808");
    expect(ansiToHex(255)).toBe("#eeeeee");
  });
});

describe("resolveThemeJson", () => {
  const json: ThemeJson = {
    defs: { purple: "#BD93F9", base: 4 },
    theme: {
      primary: "purple",
      secondary: { dark: "purple", light: "#111111" },
      accent: "base",
      chained: "primary",
      empty: "none"
    }
  };

  it("resolves hex, refs, ansi numbers, variants, and none", () => {
    const dark = resolveThemeJson(json, "dark");
    expect(dark.primary).toBe("#bd93f9");        // hex lowercased via defs ref
    expect(dark.secondary).toBe("#bd93f9");      // dark variant -> defs ref
    expect(dark.accent).toBe("#000080");         // ansi number via defs ref
    expect(dark.chained).toBe("#bd93f9");        // theme-key reference
    expect(dark.empty).toBe("");                 // "none"
    expect(resolveThemeJson(json, "light").secondary).toBe("#111111");
  });

  it("throws on unknown references", () => {
    expect(() => resolveThemeJson({ theme: { a: "nope" } }, "dark")).toThrow(/nope/);
  });

  it("throws on circular references", () => {
    expect(() => resolveThemeJson({ theme: { a: "b", b: "a" } }, "dark")).toThrow(/circular/i);
  });
});
