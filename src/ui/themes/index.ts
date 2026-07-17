import type { ThemeJson, ThemeMode } from "../themeJson.js";
import dark from "./dark.js";
import light from "./light.js";
import mono from "./mono.js";

export const BUILTIN_THEME_JSONS: Record<string, ThemeJson> = { dark, light, mono };

// Variant used when a definition carries { dark, light } values. Everything
// defaults to dark; only the light theme resolves its light variants.
export const BUILTIN_MODES: Record<string, ThemeMode> = { light: "light" };
