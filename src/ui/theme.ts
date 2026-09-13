import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, saveSetting } from "../agent/settings.js";
import { configDir } from "../agent/providers.js";
import { resolveThemeJson, type ThemeJson } from "./themeJson.js";
import { withStandardRoles } from "./standardRoles.js";

// Pure builtin registry (browser-safe) lives in ./builtinThemes.js so
// desktop/renderer can import THEMES without pulling node:* into the Vite
// browser bundle. Everything historically imported from here keeps working
// via the re-export below.
export { THEMES, registerTheme, toAppTheme } from "./builtinThemes.js";
export type { Theme } from "./builtinThemes.js";
import { BUILTIN_THEME_JSONS as BUILTINS, BUILTIN_MODES } from "./themes/index.js";
import { THEMES, registerTheme } from "./builtinThemes.js";

export function loadThemeName(filePath?: string): string {
  const { theme } = loadSettings(filePath);
  return theme && theme in THEMES ? theme : "dark";
}

export function saveThemeName(name: string, filePath?: string): void {
  saveSetting("theme", name, filePath);
}

// Loads user theme files from <configDir>/themes/*.json. Theme name is the
// filename without extension; a custom theme overrides a built-in of the
// same name. Roles a file does not declare are filled from the standard
// role template (see standardRoles.ts), so a minimal theme renders fully
// instead of falling back to gray. Broken files are skipped with a warning
// so a bad theme can never prevent startup.
export function loadCustomThemes(dir: string = join(configDir(), "themes")): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const warnings: string[] = [];
  for (const entry of entries.filter(e => e.endsWith(".json"))) {
    const name = entry.slice(0, -".json".length);
    try {
      const json = JSON.parse(readFileSync(join(dir, entry), "utf8")) as ThemeJson;
      if (!json || typeof json !== "object" || typeof json.theme !== "object") {
        throw new Error("missing \"theme\" object");
      }
      registerTheme(name, json, "dark");
      // Validate the light variant too so a mode switch can't crash later.
      resolveThemeJson({ ...json, theme: withStandardRoles(json.theme, json.defs) }, "light");
    } catch (err) {
      if (BUILTINS[name]) {
        registerTheme(name, BUILTINS[name], BUILTIN_MODES[name]);
      } else {
        delete THEMES[name];
      }
      warnings.push(`Skipped theme ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return warnings;
}
