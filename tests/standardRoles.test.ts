import { describe, it, expect } from "vitest";
import { STANDARD_ROLES, withStandardRoles } from "../src/ui/standardRoles.js";
import { resolveThemeJson, type ThemeJson } from "../src/ui/themeJson.js";

describe("STANDARD_ROLES", () => {
  it("contains exactly the evidence-based rules", () => {
    expect(Object.keys(STANDARD_ROLES).sort()).toEqual([
      "diffAdded", "diffContext", "diffContextBg", "diffHighlightAdded",
      "diffHighlightRemoved", "diffRemoved", "markdownBlockQuote",
      "markdownCode", "markdownCodeBlock", "markdownEmph",
      "markdownListEnumeration", "markdownListItem", "markdownText",
      "syntaxComment", "syntaxPunctuation"
    ]);
  });

  it("values resolve through references for both modes", () => {
    const json: ThemeJson = {
      defs: { brand: "#123456" },
      theme: {
        primary: "brand", success: "brand", error: "brand", warning: "brand",
        accent: "brand", text: "brand", textMuted: "brand",
        backgroundPanel: "brand",
        ...withStandardRoles({})
      }
    };
    expect(resolveThemeJson(json, "dark").markdownListItem).toBe("#123456");
    expect(resolveThemeJson(json, "light").diffAdded).toBe("#123456");
  });
});

describe("withStandardRoles", () => {
  const core = { primary: "#111111", success: "#222222", error: "#333333" };

  it("fills missing keys with the template", () => {
    const out = withStandardRoles(core);
    expect(out.diffAdded).toEqual({ dark: "success", light: "success" });
    expect(out.syntaxComment).toEqual({ dark: "textMuted", light: "textMuted" });
  });

  it("never overrides an explicit key", () => {
    const explicit = { ...core, diffAdded: { dark: "primary", light: "primary" } };
    const out = withStandardRoles(explicit);
    expect(out.diffAdded).toEqual({ dark: "primary", light: "primary" });
  });

  it("does not mutate its input", () => {
    const input = { ...core };
    withStandardRoles(input);
    expect(input).toEqual(core);
  });
});
