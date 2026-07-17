import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, saveSetting } from "../agent/settings.js";
import { configDir } from "../agent/providers.js";
import { resolveThemeJson, type ThemeJson, type ThemeMode } from "./themeJson.js";
import { BUILTIN_THEME_JSONS, BUILTIN_MODES } from "./themes/index.js";

// App-facing theme: the 8 roles cloudcode's widgets consume, as "#rrggbb"
// strings (the native sgr() accepts hex). Extra resolved keys from the
// opencode schema are retained for future widgets.
export interface Theme {
  user: string;
  accent: string;
  muted: string;
  error: string;
  success: string;
  removed: string;
  warning: string;
  // Color for the streaming "thinking" preview, kept visually distinct from
  // real assistant/user text so the two are never confused (dim alone isn't
  // reliably rendered by every terminal).
  thinking: string;
  [extra: string]: string;
}

const FALLBACK = "#c0c0c0";

// Maps opencode role names onto cloudcode's app roles, with fallbacks so a
// minimal theme definition still yields a fully usable Theme.
export function toAppTheme(resolved: Record<string, string>): Theme {
  const pick = (...keys: string[]) => keys.map(k => resolved[k]).find(v => v) ?? FALLBACK;
  return {
    ...resolved,
    user: pick("secondary", "primary"),
    accent: pick("accent", "primary"),
    muted: pick("textMuted", "text"),
    error: pick("error"),
    success: pick("success"),
    warning: pick("warning"),
    removed: pick("diffRemoved", "error"),
    thinking: pick("thinking", "textMuted")
  };
}

export const THEMES: Record<string, Theme> = {};

export function registerTheme(name: string, json: ThemeJson, mode?: ThemeMode): void {
  THEMES[name] = toAppTheme(resolveThemeJson(json, mode ?? BUILTIN_MODES[name] ?? "dark"));
}

for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) registerTheme(name, json);

export function loadThemeName(filePath?: string): string {
  const { theme } = loadSettings(filePath);
  return theme && theme in THEMES ? theme : "dark";
}

export function saveThemeName(name: string, filePath?: string): void {
  saveSetting("theme", name, filePath);
}

// Loads user theme files from <configDir>/themes/*.json. Theme name is the
// filename without extension; a custom theme overrides a built-in of the
// same name. Broken files are skipped with a warning so a bad theme can
// never prevent startup.
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
      resolveThemeJson(json, "light");
    } catch (err) {
      if (BUILTIN_THEME_JSONS[name]) {
        registerTheme(name, BUILTIN_THEME_JSONS[name], BUILTIN_MODES[name]);
      } else {
        delete THEMES[name];
      }
      warnings.push(`Skipped theme ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return warnings;
}
