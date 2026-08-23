import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";
import { resolveThemeJson } from "../src/ui/themeJson.js";

// Pins current resolver output for all builtins in both modes. During the
// standard-roles refactor this must never regress: existing keys keep their
// exact value; NEW keys must equal the template derivation (checked once the
// template exists — see tests/standardRoles.test.ts).
const root = join(import.meta.dirname, "..");
const goldens = JSON.parse(
  readFileSync(join(root, "tests/fixtures/theme-golden.json"), "utf8")
) as Record<string, { dark: Record<string, string>; light: Record<string, string> }>;

describe("theme golden fixtures", () => {
  for (const mode of ["dark", "light"] as const) {
    it(`every builtin resolves identically to the golden fixture (${mode})`, () => {
      for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) {
        const golden = goldens[name]?.[mode];
        expect(golden, `missing golden for ${name}`).toBeDefined();
        const resolved = resolveThemeJson(json, mode);
        // Subset equality: keys known at golden time must not change value.
        for (const [key, value] of Object.entries(golden)) {
          expect(resolved[key], `${name}/${mode}/${key}`).toBe(value);
        }
      }
    });
  }
});
