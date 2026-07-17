// Theme definition format compatible with opencode's TUI theme JSON schema:
// a "defs" palette plus a "theme" role map whose values are hex strings,
// ANSI color numbers (0-255), references to defs/theme keys, "none", or
// { dark, light } variant objects.
export type ColorValue = string | number | { dark: ColorValue; light: ColorValue };

export interface ThemeJson {
  $schema?: string;
  defs?: Record<string, ColorValue>;
  theme: Record<string, ColorValue>;
}

export type ThemeMode = "dark" | "light";

// Standard 16-color palette as rendered by most terminals (VGA-ish values,
// matching the xterm 256-color table entries 0-15).
export const ANSI16_HEX: readonly string[] = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function ansiToHex(n: number): string {
  if (n < 16) return ANSI16_HEX[n];
  if (n < 232) {
    const i = n - 16;
    return toHex(CUBE_LEVELS[Math.floor(i / 36)], CUBE_LEVELS[Math.floor(i / 6) % 6], CUBE_LEVELS[i % 6]);
  }
  const gray = 8 + 10 * (n - 232);
  return toHex(gray, gray, gray);
}

function isVariant(v: ColorValue): v is { dark: ColorValue; light: ColorValue } {
  return typeof v === "object" && v !== null;
}

// Flattens a theme definition for the given mode. Every value becomes a
// lowercase "#rrggbb" string ("" for "none"). Throws on unknown or circular
// references so broken theme files fail loudly at load time, not mid-render.
export function resolveThemeJson(json: ThemeJson, mode: ThemeMode): Record<string, string> {
  const resolve = (v: ColorValue, seen: ReadonlySet<string>): string => {
    if (isVariant(v)) return resolve(v[mode], seen);
    if (typeof v === "number") return ansiToHex(v);
    if (v === "none") return "";
    if (v.startsWith("#")) return v.toLowerCase();
    if (seen.has(v)) throw new Error(`Circular color reference: ${v}`);
    const next = json.defs?.[v] ?? json.theme[v];
    if (next === undefined) throw new Error(`Unknown color reference: ${v}`);
    return resolve(next, new Set(seen).add(v));
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(json.theme)) out[key] = resolve(value, new Set());
  return out;
}
