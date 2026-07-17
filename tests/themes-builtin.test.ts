import { describe, it, expect } from "vitest";
import { resolveThemeJson } from "../src/ui/themeJson.js";
import { toAppTheme } from "../src/ui/theme.js";
import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";

const PORTED = [
  "dracula", "catppuccin", "gruvbox", "tokyonight", "nord",
  "one-dark", "solarized", "rosepine", "github", "monokai"
];
const HEX_OR_NONE = /^(#[0-9a-f]{6}|)$/;
const ROLES = ["user", "accent", "muted", "error", "success", "removed", "warning", "thinking"] as const;

describe("ported opencode themes", () => {
  it("are all registered", () => {
    for (const name of PORTED) expect(BUILTIN_THEME_JSONS[name], name).toBeDefined();
  });

  it("resolve cleanly in both modes with valid colors", () => {
    for (const name of PORTED) {
      for (const mode of ["dark", "light"] as const) {
        const resolved = resolveThemeJson(BUILTIN_THEME_JSONS[name], mode);
        for (const [key, value] of Object.entries(resolved)) {
          expect(value, `${name}/${mode}/${key}`).toMatch(HEX_OR_NONE);
        }
        const app = toAppTheme(resolved);
        for (const role of ROLES) {
          expect(app[role], `${name}/${mode}/${role}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });
});
