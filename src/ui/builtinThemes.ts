// Browser-safe builtin theme registry. Deliberately free of node:* and
// src/agent imports so desktop/renderer (Vite browser bundle) can import
// THEMES without externalizing fs/path/os. Node-only helpers
// (loadThemeName/saveThemeName/loadCustomThemes) stay in ./theme.js, which
// re-exports everything here for backward compatibility.
import { resolveThemeJson, type ThemeJson, type ThemeMode } from "./themeJson.js";
import { withStandardRoles } from "./standardRoles.js";
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

// Darkens a "#rrggbb" color by scaling each channel. The thinking preview
// should sit slightly below normal text in visual weight in every theme.
function darken(hex: string, factor = 0.8): string {
  const n = parseInt(hex.slice(1), 16);
  const scale = (c: number) => Math.round(c * factor).toString(16).padStart(2, "0");
  return `#${scale((n >> 16) & 0xff)}${scale((n >> 8) & 0xff)}${scale(n & 0xff)}`;
}

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
    thinking: darken(pick("thinking", "textMuted"))
  };
}

export const THEMES: Record<string, Theme> = {};

export function registerTheme(name: string, json: ThemeJson, mode?: ThemeMode): void {
  const effective: ThemeJson = { ...json, theme: withStandardRoles(json.theme, json.defs) };
  THEMES[name] = toAppTheme(resolveThemeJson(effective, mode ?? BUILTIN_MODES[name] ?? "dark"));
}

for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) registerTheme(name, json);
