import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveThemeJson, type ThemeJson, type ColorValue } from "../src/ui/themeJson.js";
import { withStandardRoles } from "../src/ui/standardRoles.js";

// One-shot migration: drop standard-derivable roles from a theme file and
// rewrite it in canonical format. Verifies resolved-output equality for the
// file (both modes) before writing; refuses to touch it otherwise.

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: tsx scripts/tmp-shrink-theme.ts <name> ...");
  process.exit(2);
}

const root = join(import.meta.dirname, "..");
const { BUILTIN_THEME_JSONS } = await import("../src/ui/themes/index.js");

function withoutKey(map: Record<string, ColorValue>, key: string): Record<string, ColorValue> {
  const copy: Record<string, ColorValue> = { ...map };
  delete copy[key];
  return copy;
}

for (const name of args) {
  const path = join(root, "src/ui/themes", `${name}.ts`);
  const source = readFileSync(path, "utf8");
  const commentLines: string[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("//")) commentLines.push(line);
    else if (line.trim() !== "") break;
  }
  const json = JSON.parse(JSON.stringify(BUILTIN_THEME_JSONS[name])) as ThemeJson;
  const before = {
    dark: resolveThemeJson(json, "dark"),
    light: resolveThemeJson(json, "light")
  };

  // A key is deletable when removing it and letting the template derive it
  // yields identical resolved values in both modes.
  const deletable = Object.keys(json.theme).filter(key => {
    if (!withStandardRoles(withoutKey(json.theme, key), json.defs)[key]) return false;
    const derived = { ...json, theme: withStandardRoles(withoutKey(json.theme, key), json.defs) };
    return resolveThemeJson(derived, "dark")[key] === before.dark[key]
      && resolveThemeJson(derived, "light")[key] === before.light[key];
  });

  const newThemeMap = deletable.reduce((m, k) => withoutKey(m, k), json.theme);
  const after = {
    dark: resolveThemeJson({ ...json, theme: withStandardRoles(newThemeMap, json.defs) }, "dark"),
    light: resolveThemeJson({ ...json, theme: withStandardRoles(newThemeMap, json.defs) }, "light")
  };
  for (const mode of ["dark", "light"] as const) {
    for (const [key, value] of Object.entries(before[mode])) {
      if (after[mode][key] !== value) {
        throw new Error(`${name}: ${mode}/${key} changed: ${value} -> ${after[mode][key]}`);
      }
    }
  }

  const body: Record<string, unknown> = {};
  if (json.$schema) body.$schema = json.$schema;
  if (json.defs && Object.keys(json.defs).length > 0) body.defs = json.defs;
  body.theme = newThemeMap;
  const rendered = JSON.stringify(body, null, 2);
  const header = [...commentLines, 'import type { ThemeJson } from "../themeJson.js";', ""].join("\n");
  const out = `${header}\nconst theme: ThemeJson = ${rendered};\n\nexport default theme;\n`;
  writeFileSync(path, out);
  console.log(`${name}: removed ${deletable.length} roles`);
}
