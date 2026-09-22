import { afterEach, describe, expect, it } from "vitest";
import { THEMES } from "../src/ui/theme.js";
import {
  GUI_THEMES,
  GUI_THEME_STORAGE_KEY,
  applyGuiTheme,
  confirmGuiTheme,
  getConfirmedGuiTheme,
  guiThemeVars,
  loadStoredGuiTheme,
  parseThemeEvent,
  previewGuiTheme,
  resolveGuiTheme
} from "../src/desktop/renderer/themeState.js";

describe("gui theme palette", () => {
  it("covers every TUI theme name so /theme never misses in the GUI", () => {
    expect(Object.keys(GUI_THEMES).sort()).toEqual(Object.keys(THEMES).sort());
  });
  it("gives every theme a complete non-empty hex var set", () => {
    for (const vars of Object.values(GUI_THEMES)) {
      expect(Object.values(vars)).toHaveLength(7);
      for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
  it("falls back to dark for unknown names", () => {
    expect(resolveGuiTheme("nope")).toBe("dark");
    expect(guiThemeVars("nope")).toEqual(GUI_THEMES.dark);
    expect(guiThemeVars("dracula").accent).toBe("#8be9fd");
  });
  it("uses a stable storage key", () => {
    expect(GUI_THEME_STORAGE_KEY).toBe("cloudcode.theme");
  });
  it("parses theme events without throwing on malformed payloads", () => {
    expect(parseThemeEvent({ type: "theme", text: "dracula" })).toBe("dracula");
    expect(parseThemeEvent({ type: "notice", text: "dracula" })).toBeUndefined();
    expect(parseThemeEvent({ type: "theme", text: "" })).toBeUndefined();
    expect(parseThemeEvent({ type: "theme" })).toBeUndefined();
  });
  it("applyGuiTheme persists without a DOM", () => {
    expect(applyGuiTheme("dracula")).toBe("dracula");
    expect(applyGuiTheme("nope")).toBe("dark");
    expect(loadStoredGuiTheme()).toBeUndefined();
  });
  it("previews without persisting and reverts to the confirmed theme", () => {
    expect(confirmGuiTheme("dracula")).toBe("dracula");
    expect(getConfirmedGuiTheme()).toBe("dracula");
    expect(previewGuiTheme("light")).toBe("light");
    expect(getConfirmedGuiTheme()).toBe("dracula");
    expect(previewGuiTheme("nope")).toBe("dark");
    expect(getConfirmedGuiTheme()).toBe("dracula");
    expect(confirmGuiTheme("nope")).toBe("dark");
    expect(getConfirmedGuiTheme()).toBe("dark");
  });
});

describe("native title bar theme synchronization", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");
  });

  it("uses light controls for the light theme and dark otherwise", () => {
    const nativeThemes: string[] = [];
    const props: Record<string, string> = {};
    const fakeRoot = {
      dataset: {} as Record<string, string>,
      style: { setProperty: (key: string, value: string) => { props[key] = value; } }
    };
    (globalThis as Record<string, unknown>)["document"] = { documentElement: fakeRoot };
    (globalThis as Record<string, unknown>)["window"] = {
      cloudcode: {
        setNativeTheme: (name: string) => {
          nativeThemes.push(name);
          return Promise.resolve();
        }
      }
    };

    expect(applyGuiTheme("light")).toBe("light");
    expect(applyGuiTheme("dracula")).toBe("dracula");
    expect(props["color-scheme"]).toBe("dark");
    expect(nativeThemes).toEqual(["light", "dark"]);
  });
});
