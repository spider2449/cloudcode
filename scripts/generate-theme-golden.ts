import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";
import { resolveThemeJson } from "../src/ui/themeJson.js";

const root = join(import.meta.dirname, "..");
const out: Record<string, { dark: Record<string, string>; light: Record<string, string> }> = {};
for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) {
  out[name] = {
    dark: resolveThemeJson(json, "dark"),
    light: resolveThemeJson(json, "light")
  };
}
mkdirSync(join(root, "tests/fixtures"), { recursive: true });
writeFileSync(
  join(root, "tests/fixtures/theme-golden.json"),
  JSON.stringify(out, null, 2) + "\n"
);
console.log(`wrote goldens for ${Object.keys(out).length} themes`);
