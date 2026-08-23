import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";
import { resolveThemeJson, type ThemeJson } from "../src/ui/themeJson.js";
import { STANDARD_ROLES, withStandardRoles } from "../src/ui/standardRoles.js";

// Reports which explicitly-declared roles each builtin theme may drop
// because the standard template derives the identical resolved value in
// both modes. Keys not listed must stay as per-theme data.

function withoutKey(map: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...map };
  delete copy[key];
  return copy;
}

function effective(json: ThemeJson, theme: Record<string, unknown>): ThemeJson {
  return { ...json, theme: withStandardRoles(theme as ThemeJson["theme"], json.defs) };
}

let totalDeletable = 0;
for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) {
  const deletable: string[] = [];
  for (const key of Object.keys(STANDARD_ROLES)) {
    if (json.theme[key] === undefined) continue;
    const derived = effective(json, withoutKey(json.theme, key));
    const darkDerived = resolveThemeJson(derived, "dark")[key];
    const lightDerived = resolveThemeJson(derived, "light")[key];
    const darkExplicit = resolveThemeJson(json, "dark")[key];
    const lightExplicit = resolveThemeJson(json, "light")[key];
    if (darkDerived === darkExplicit && lightDerived === lightExplicit) {
      deletable.push(key);
    }
  }
  totalDeletable += deletable.length;
  console.log(`${name}: delete ${deletable.length} -> ${deletable.join(", ")}`);
}
console.log(`\ntotal deletable keys: ${totalDeletable}`);
