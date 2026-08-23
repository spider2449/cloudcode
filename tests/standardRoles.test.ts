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
    const core = {
      primary: "#123456", success: "#123456", error: "#123456", warning: "#123456",
      accent: "#123456", text: "#123456", textMuted: "#123456", backgroundPanel: "#123456"
    };
    const json: ThemeJson = { theme: withStandardRoles(core) };
    expect(resolveThemeJson(json, "dark").markdownListItem).toBe("#123456");
    expect(resolveThemeJson(json, "light").diffAdded).toBe("#123456");
  });
});

describe("withStandardRoles", () => {
  // Every core role the template references.
  const core = {
    primary: "#111111", success: "#222222", error: "#333333",
    warning: "#444444", accent: "#555555", text: "#666666",
    textMuted: "#777777", backgroundPanel: "#888888"
  };

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

  it("skips a derivation whose references cannot resolve", () => {
    // No backgroundPanel anywhere: diffContextBg must NOT be filled, or
    // resolution would fail with an unknown reference.
    const out = withStandardRoles({ primary: "#111111", success: "#222222" });
    expect(out.diffContextBg).toBeUndefined();
  });
});
