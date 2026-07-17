import type { ThemeJson, ThemeMode } from "../themeJson.js";
import dark from "./dark.js";
import light from "./light.js";
import mono from "./mono.js";
import dracula from "./dracula.js";
import catppuccin from "./catppuccin.js";
import gruvbox from "./gruvbox.js";
import tokyonight from "./tokyonight.js";
import nord from "./nord.js";
import oneDark from "./one-dark.js";
import solarized from "./solarized.js";
import rosepine from "./rosepine.js";
import github from "./github.js";
import monokai from "./monokai.js";

export const BUILTIN_THEME_JSONS: Record<string, ThemeJson> = {
  dark, light, mono,
  dracula, catppuccin, gruvbox, tokyonight, nord,
  "one-dark": oneDark, solarized, rosepine, github, monokai
};

// Variant used when a definition carries { dark, light } values. Everything
// defaults to dark; only the light theme resolves its light variants.
export const BUILTIN_MODES: Record<string, ThemeMode> = { light: "light" };
