import { describe, expect, it } from "vitest";
import { THEMES } from "../src/ui/theme.js";
import { resolveMenuThemeName, themeMenuItems } from "../src/desktop/appMenu.js";

describe("desktop OS menu bar theme items", () => {
  it("covers every TUI theme name in a stable order", () => {
    const items = themeMenuItems(Object.keys(THEMES), "dark");
    expect(items.map(i => i.name)).toEqual(Object.keys(THEMES).sort());
    for (const item of items) expect(item.label).toBe(item.name);
  });
  it("checks the current theme and nothing else", () => {
    const items = themeMenuItems(["dark", "light", "dracula"], "dracula");
    expect(items.filter(i => i.checked).map(i => i.name)).toEqual(["dracula"]);
    expect(themeMenuItems(["dark", "light"], "nope").some(i => i.checked)).toBe(false);
  });
  it("validates theme-set payloads without throwing", () => {
    expect(resolveMenuThemeName("dracula", Object.keys(THEMES))).toBe("dracula");
    expect(resolveMenuThemeName("nope", Object.keys(THEMES))).toBeUndefined();
    expect(resolveMenuThemeName(undefined, Object.keys(THEMES))).toBeUndefined();
    expect(resolveMenuThemeName(42, Object.keys(THEMES))).toBeUndefined();
  });
});
