# Theme System Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3 hard-coded named-ANSI-color themes with an opencode-compatible JSON theme system: hex/truecolor rendering with automatic downgrade, ~10 popular bundled themes, and user custom themes in `~/.cloudcode/themes/`.

**Architecture:** Theme definitions use opencode's JSON schema (`defs` palette + `theme` role map with hex / ANSI-number / reference / dark-light-variant values), embedded as TypeScript modules so `tsc`, `tsx`, vitest, and binary packaging all work without build changes. A resolver flattens a definition to hex strings and maps opencode roles onto cloudcode's existing 8-role `Theme` interface, so every existing consumer (Ink `<Text color>` accepts hex; native `sgr()` is extended to emit truecolor/256/16) keeps working.

**Tech Stack:** TypeScript (tsc, NodeNext ESM), vitest, Ink 5, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-theme-system-design.md`

## Global Constraints

- All code comments MUST be in English (user's global CLAUDE.md rule).
- No new npm dependencies.
- Node >= 18; build is plain `tsc -p tsconfig.json` — do NOT enable `resolveJsonModule` or ship runtime-read `.json` assets (binary packaging bundles only compiled JS). Theme definitions are `.ts` modules whose default export is the JSON content pasted verbatim as an object literal.
- Never emit OSC background-query sequences (legacy conhost quirks); color depth detection is env-based only.
- The exported names `THEMES`, `Theme`, `loadThemeName`, `saveThemeName` in `src/ui/theme.ts` must keep working — many consumers import them.
- Run tests with `npx vitest run <file>`; note the repo has known pre-existing failures in unrelated suites (skills env pollution, provider flake) — judge success by the suites touched here.

---

### Task 1: Theme JSON types and resolver

**Files:**
- Create: `src/ui/themeJson.ts`
- Test: `tests/themeJson.test.ts`

**Interfaces:**
- Produces:
  - `type ColorValue = string | number | { dark: ColorValue; light: ColorValue }`
  - `interface ThemeJson { $schema?: string; defs?: Record<string, ColorValue>; theme: Record<string, ColorValue> }`
  - `type ThemeMode = "dark" | "light"`
  - `ansiToHex(n: number): string` — 0–255 → `"#rrggbb"` (lowercase)
  - `resolveThemeJson(json: ThemeJson, mode: ThemeMode): Record<string, string>` — every theme key → `"#rrggbb"` or `""` (for `"none"`); throws `Error` on unknown or circular references.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/themeJson.test.ts
import { describe, it, expect } from "vitest";
import { ansiToHex, resolveThemeJson, type ThemeJson } from "../src/ui/themeJson.js";

describe("ansiToHex", () => {
  it("maps the standard 16 colors", () => {
    expect(ansiToHex(0)).toBe("#000000");
    expect(ansiToHex(1)).toBe("#800000");
    expect(ansiToHex(4)).toBe("#000080");
    expect(ansiToHex(7)).toBe("#c0c0c0");
    expect(ansiToHex(9)).toBe("#ff0000");
    expect(ansiToHex(15)).toBe("#ffffff");
  });
  it("maps the 6x6x6 cube", () => {
    expect(ansiToHex(16)).toBe("#000000");   // 0,0,0
    expect(ansiToHex(196)).toBe("#ff0000");  // 5,0,0
    expect(ansiToHex(231)).toBe("#ffffff");  // 5,5,5
    expect(ansiToHex(110)).toBe("#87afd7");  // 2,3,4 -> 135,175,215
  });
  it("maps the grayscale ramp", () => {
    expect(ansiToHex(232)).toBe("#080808");
    expect(ansiToHex(255)).toBe("#eeeeee");
  });
});

describe("resolveThemeJson", () => {
  const json: ThemeJson = {
    defs: { purple: "#BD93F9", base: 4 },
    theme: {
      primary: "purple",
      secondary: { dark: "purple", light: "#111111" },
      accent: "base",
      chained: "primary",
      empty: "none"
    }
  };

  it("resolves hex, refs, ansi numbers, variants, and none", () => {
    const dark = resolveThemeJson(json, "dark");
    expect(dark.primary).toBe("#bd93f9");        // hex lowercased via defs ref
    expect(dark.secondary).toBe("#bd93f9");      // dark variant -> defs ref
    expect(dark.accent).toBe("#000080");         // ansi number via defs ref
    expect(dark.chained).toBe("#bd93f9");        // theme-key reference
    expect(dark.empty).toBe("");                 // "none"
    expect(resolveThemeJson(json, "light").secondary).toBe("#111111");
  });

  it("throws on unknown references", () => {
    expect(() => resolveThemeJson({ theme: { a: "nope" } }, "dark")).toThrow(/nope/);
  });

  it("throws on circular references", () => {
    expect(() => resolveThemeJson({ theme: { a: "b", b: "a" } }, "dark")).toThrow(/circular/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/themeJson.test.ts`
Expected: FAIL — cannot resolve `../src/ui/themeJson.js`.

- [ ] **Step 3: Implement `src/ui/themeJson.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/themeJson.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/ui/themeJson.ts tests/themeJson.test.ts
git commit -m "feat(ui): add opencode-compatible theme JSON resolver"
```

---

### Task 2: Truecolor `sgr()` with automatic downgrade

**Files:**
- Modify: `src/ui/term/ansi.ts` (extend `sgr`, ~lines 46-56)
- Test: `tests/ansi-color.test.ts` (new)

**Interfaces:**
- Consumes: `ANSI16_HEX` from Task 1 (`src/ui/themeJson.ts`).
- Produces:
  - `type ColorDepth = "truecolor" | "256" | "16"`
  - `detectColorDepth(env?: NodeJS.ProcessEnv, platform?: string): ColorDepth`
  - `setColorDepth(d: ColorDepth): void` — override for tests/runtime
  - `sgr(color: string | undefined): string` — now also accepts `"#rrggbb"`; legacy names (`"blue"`, `"gray"`, …) still work.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ansi-color.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { sgr, setColorDepth, detectColorDepth } from "../src/ui/term/ansi.js";

afterEach(() => setColorDepth(detectColorDepth()));

describe("detectColorDepth", () => {
  it("honors COLORTERM", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor" }, "linux")).toBe("truecolor");
    expect(detectColorDepth({ COLORTERM: "24bit" }, "linux")).toBe("truecolor");
  });
  it("treats win32 as truecolor (Win10+ conhost supports 24-bit SGR)", () => {
    expect(detectColorDepth({}, "win32")).toBe("truecolor");
  });
  it("falls back via TERM", () => {
    expect(detectColorDepth({ TERM: "xterm-256color" }, "linux")).toBe("256");
    expect(detectColorDepth({ TERM: "xterm" }, "linux")).toBe("16");
  });
});

describe("sgr with hex colors", () => {
  it("emits truecolor sequences", () => {
    setColorDepth("truecolor");
    expect(sgr("#bd93f9")).toBe("\x1b[38;2;189;147;249m");
  });
  it("downgrades to nearest 256-color", () => {
    setColorDepth("256");
    expect(sgr("#ff0000")).toBe("\x1b[38;5;196m");
    expect(sgr("#080808")).toBe("\x1b[38;5;232m");
  });
  it("downgrades to nearest basic-16", () => {
    setColorDepth("16");
    expect(sgr("#ff0000")).toBe("\x1b[91m");  // bright red
    expect(sgr("#800000")).toBe("\x1b[31m");  // dark red
    expect(sgr("#000080")).toBe("\x1b[34m");  // dark blue round-trips
  });
  it("keeps legacy names working and rejects garbage", () => {
    setColorDepth("truecolor");
    expect(sgr("blue")).toBe("\x1b[34m");
    expect(sgr("gray")).toBe("\x1b[90m");
    expect(sgr(undefined)).toBe("");
    expect(sgr("#zzz")).toBe("");
    expect(sgr("")).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ansi-color.test.ts`
Expected: FAIL — `setColorDepth`/`detectColorDepth` not exported.

- [ ] **Step 3: Extend `src/ui/term/ansi.ts`**

Replace the existing `COLOR_CODES` + `sgr` block (currently lines 46-56) with:

```ts
import { ANSI16_HEX } from "../themeJson.js";

const COLOR_CODES: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, blackBright: 90
};

export type ColorDepth = "truecolor" | "256" | "16";

// Env-only detection; never queries the terminal (legacy conhost mishandles
// several DEC/OSC queries, so probing is off the table).
export function detectColorDepth(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform
): ColorDepth {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  // Windows 10+ conhost and Windows Terminal both render 24-bit SGR.
  if (platform === "win32") return "truecolor";
  if (/256color/.test(env.TERM ?? "")) return "256";
  return "16";
}

let colorDepth: ColorDepth = detectColorDepth();

export function setColorDepth(d: ColorDepth): void {
  colorDepth = d;
}

function hexToRgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Nearest xterm-256 index: pick the better of the closest cube entry and the
// closest grayscale entry by squared RGB distance.
function nearest256([r, g, b]: [number, number, number]): number {
  const level = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : Math.min(5, Math.round((c - 55) / 40)));
  const cubeVal = (i: number) => (i === 0 ? 0 : 55 + i * 40);
  const [ri, gi, bi] = [level(r), level(g), level(b)];
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (cubeVal(ri) - r) ** 2 + (cubeVal(gi) - g) ** 2 + (cubeVal(bi) - b) ** 2;
  const grayIdx = Math.max(0, Math.min(23, Math.round((((r + g + b) / 3) - 8) / 10)));
  const grayVal = 8 + 10 * grayIdx;
  const grayDist = (grayVal - r) ** 2 + (grayVal - g) ** 2 + (grayVal - b) ** 2;
  return grayDist < cubeDist ? 232 + grayIdx : cubeIdx;
}

// Nearest of the standard 16 colors, returned as an SGR foreground code
// (30-37 for 0-7, 90-97 for 8-15).
function nearest16Sgr([r, g, b]: [number, number, number]): number {
  let best = 0;
  let bestDist = Infinity;
  ANSI16_HEX.forEach((hex, i) => {
    const [pr, pg, pb] = hexToRgb(hex)!;
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best < 8 ? 30 + best : 90 + (best - 8);
}

export function sgr(color: string | undefined): string {
  if (!color) return "";
  if (color.startsWith("#")) {
    const rgb = hexToRgb(color);
    if (!rgb) return "";
    if (colorDepth === "truecolor") return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    if (colorDepth === "256") return `\x1b[38;5;${nearest256(rgb)}m`;
    return `\x1b[${nearest16Sgr(rgb)}m`;
  }
  const code = COLOR_CODES[color];
  if (code === undefined) return "";
  return `\x1b[${code}m`;
}
```

- [ ] **Step 4: Run new + existing render tests**

Run: `npx vitest run tests/ansi-color.test.ts tests/render.test.ts tests/inputBox.test.ts`
Expected: PASS — existing suites still pass because legacy names are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/ansi.ts tests/ansi-color.test.ts
git commit -m "feat(ui): truecolor sgr with 256/16-color downgrade"
```

---

### Task 3: Built-in dark/light/mono rewritten in the JSON schema; new THEMES registry

**Files:**
- Create: `src/ui/themes/dark.ts`, `src/ui/themes/light.ts`, `src/ui/themes/mono.ts`, `src/ui/themes/index.ts`
- Modify: `src/ui/theme.ts` (whole file)
- Modify: `tests/theme.test.ts`
- Modify: `src/commands/builtins.ts:349` (theme command description only)

**Interfaces:**
- Consumes: `ThemeJson`, `ThemeMode`, `resolveThemeJson` (Task 1).
- Produces:
  - `src/ui/themes/index.ts`: `BUILTIN_THEME_JSONS: Record<string, ThemeJson>` and `BUILTIN_MODES: Record<string, ThemeMode>` (only `light: "light"`; everything else defaults to dark).
  - `src/ui/theme.ts` keeps: `interface Theme` (same 8 required roles, values now hex strings, plus `[extra: string]: string` index signature), `THEMES: Record<string, Theme>`, `loadThemeName`, `saveThemeName`.
  - New: `toAppTheme(resolved: Record<string, string>): Theme` and `registerTheme(name: string, json: ThemeJson, mode?: ThemeMode): void` (used by Tasks 4-5).

- [ ] **Step 1: Rewrite `tests/theme.test.ts` (failing first)**

Replace the whole file:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadThemeName, saveThemeName, toAppTheme } from "../src/ui/theme.js";

const HEX = /^#[0-9a-f]{6}$/;
const ROLES = ["user", "accent", "muted", "error", "success", "removed", "warning", "thinking"] as const;

describe("built-in themes", () => {
  it("includes the original three", () => {
    for (const name of ["dark", "light", "mono"]) expect(THEMES[name]).toBeDefined();
  });

  it("every theme resolves all roles to hex colors", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const role of ROLES) {
        expect(theme[role], `${name}.${role}`).toMatch(HEX);
      }
    }
  });

  it("every theme defines a thinking color distinct from its user color", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.thinking).toBeTruthy();
      expect(theme.thinking).not.toBe(theme.user);
    }
  });
});

describe("toAppTheme role mapping", () => {
  const base = {
    primary: "#010101", secondary: "#020202", accent: "#030303", text: "#040404",
    textMuted: "#050505", error: "#060606", success: "#070707", warning: "#080808"
  };
  it("maps opencode roles onto app roles with fallbacks", () => {
    const t = toAppTheme({ ...base, diffRemoved: "#090909", thinking: "#0a0a0a" });
    expect(t.user).toBe("#020202");        // secondary
    expect(t.accent).toBe("#030303");
    expect(t.muted).toBe("#050505");       // textMuted
    expect(t.removed).toBe("#090909");     // diffRemoved
    expect(t.thinking).toBe("#0a0a0a");    // explicit key wins
  });
  it("falls back when optional roles are missing", () => {
    const t = toAppTheme(base);
    expect(t.removed).toBe("#060606");     // error
    expect(t.thinking).toBe("#050505");    // textMuted
  });
  it("keeps extra resolved keys accessible", () => {
    const t = toAppTheme({ ...base, diffAdded: "#0b0b0b" });
    expect(t.diffAdded).toBe("#0b0b0b");
  });
});

describe("theme persistence", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "theme-"));

  it("round-trips a saved theme name", () => {
    const file = join(dir(), "theme.json");
    saveThemeName("light", file);
    expect(loadThemeName(file)).toBe("light");
  });

  it("falls back to dark when the file is missing", () => {
    expect(loadThemeName(join(dir(), "nope.json"))).toBe("dark");
  });

  it("falls back to dark when the file is corrupt", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, "not json{{");
    expect(loadThemeName(file)).toBe("dark");
  });

  it("falls back to dark for an unknown theme name", () => {
    const file = join(dir(), "theme.json");
    writeFileSync(file, JSON.stringify({ name: "does-not-exist" }));
    expect(loadThemeName(file)).toBe("dark");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/theme.test.ts`
Expected: FAIL — `toAppTheme` not exported; hex assertions fail against named colors.

- [ ] **Step 3: Create the three built-in definitions**

The originals used named 16-colors; ANSI numbers keep them pixel-identical on 16-color terminals (the downgrade round-trips exactly) while giving truecolor terminals stable values. Original mapping: blue→4, cyan→6, gray→8, red→1, green→2, yellow→3, magenta→5, white→7, blackBright→8.

`src/ui/themes/dark.ts`:

```ts
import type { ThemeJson } from "../themeJson.js";

// Original cloudcode dark palette, expressed in the opencode theme schema.
const dark: ThemeJson = {
  theme: {
    primary: 6,
    secondary: 4,
    accent: 6,
    text: 7,
    textMuted: 8,
    error: 1,
    success: 2,
    warning: 3,
    diffAdded: 2,
    diffRemoved: 1,
    thinking: 5
  }
};

export default dark;
```

`src/ui/themes/light.ts`:

```ts
import type { ThemeJson } from "../themeJson.js";

// Original cloudcode light palette, expressed in the opencode theme schema.
const light: ThemeJson = {
  theme: {
    primary: 4,
    secondary: 5,
    accent: 4,
    text: 0,
    textMuted: 8,
    error: 1,
    success: 2,
    warning: 5,
    diffAdded: 2,
    diffRemoved: 1,
    thinking: 6
  }
};

export default light;
```

`src/ui/themes/mono.ts`:

```ts
import type { ThemeJson } from "../themeJson.js";

// Original cloudcode mono palette, expressed in the opencode theme schema.
const mono: ThemeJson = {
  theme: {
    primary: 7,
    secondary: 7,
    accent: 7,
    text: 7,
    textMuted: 8,
    error: 7,
    success: 7,
    warning: 7,
    diffAdded: 7,
    diffRemoved: 8,
    thinking: 8
  }
};

export default mono;
```

Note: mono's `thinking` (8) equals `textMuted`, and its `user` (secondary=7) differs from `thinking` — the distinct-from-user test still holds.

`src/ui/themes/index.ts`:

```ts
import type { ThemeJson, ThemeMode } from "../themeJson.js";
import dark from "./dark.js";
import light from "./light.js";
import mono from "./mono.js";

export const BUILTIN_THEME_JSONS: Record<string, ThemeJson> = { dark, light, mono };

// Variant used when a definition carries { dark, light } values. Everything
// defaults to dark; only the light theme resolves its light variants.
export const BUILTIN_MODES: Record<string, ThemeMode> = { light: "light" };
```

- [ ] **Step 4: Rewrite `src/ui/theme.ts`**

```ts
import { loadSettings, saveSetting } from "../agent/settings.js";
import { resolveThemeJson, type ThemeJson, type ThemeMode } from "./themeJson.js";
import { BUILTIN_THEME_JSONS, BUILTIN_MODES } from "./themes/index.js";

// App-facing theme: the 8 roles cloudcode's widgets consume, as "#rrggbb"
// strings (Ink's <Text color> and the native sgr() both accept hex). Extra
// resolved keys from the opencode schema are retained for future widgets.
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
```

- [ ] **Step 5: Update the `/theme` description in `src/commands/builtins.ts`**

Line 349, change:

```ts
    description: "Switch color theme: /theme <dark|light|mono>",
```

to:

```ts
    description: "Switch color theme: /theme <name> (no arg lists themes)",
```

(All other `/theme` and `/config theme` logic already iterates `Object.keys(THEMES)` — no other change.)

- [ ] **Step 6: Run the affected suites**

Run: `npx vitest run tests/theme.test.ts tests/render.test.ts tests/widgets.test.ts tests/inputBox.test.ts tests/toolResult.test.ts`
Expected: PASS. If a widget test snapshots named-color SGR codes (e.g. `\x1b[90m`), the ANSI-number round-trip keeps them identical on the 16-color path but tests run at detected depth — if any fail on exact escape codes, set depth in the test via `setColorDepth("16")` from `src/ui/term/ansi.js` in a `beforeAll`, matching the codes the suite asserts.

- [ ] **Step 7: Commit**

```bash
git add src/ui/themes src/ui/theme.ts src/commands/builtins.ts tests/theme.test.ts
git commit -m "feat(ui): rebuild THEMES on the opencode theme schema"
```

---

### Task 4: Port 10 popular opencode themes

**Files:**
- Create: `src/ui/themes/dracula.ts`, `catppuccin.ts`, `gruvbox.ts`, `tokyonight.ts`, `nord.ts`, `one-dark.ts`, `solarized.ts`, `rosepine.ts`, `github.ts`, `monokai.ts`
- Modify: `src/ui/themes/index.ts`
- Test: `tests/themes-builtin.test.ts` (new)

**Interfaces:**
- Consumes: `ThemeJson` (Task 1), `registerTheme`/`THEMES` behavior (Task 3 — index registration loop picks up new entries automatically).
- Produces: 10 new keys in `BUILTIN_THEME_JSONS`: `dracula`, `catppuccin`, `gruvbox`, `tokyonight`, `nord`, `one-dark`, `solarized`, `rosepine`, `github`, `monokai`.

- [ ] **Step 1: Fetch the source JSON files from opencode**

```bash
cd "C:/Temp/claude/D--spider-working-cloudcode/4a87d793-8fcd-4431-8f0e-b1134650724a/scratchpad"
for t in dracula catppuccin gruvbox tokyonight nord one-dark solarized rosepine github monokai; do
  curl -fsSL "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/theme/assets/$t.json" -o "$t.json"
done
ls *.json
```

Expected: 10 files listed, each valid JSON starting with `{`.

- [ ] **Step 2: Write the failing validation test**

```ts
// tests/themes-builtin.test.ts
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
```

Run: `npx vitest run tests/themes-builtin.test.ts`
Expected: FAIL — themes not registered.

- [ ] **Step 3: Convert each JSON to a TS module**

For each fetched `<name>.json`, create `src/ui/themes/<name>.ts` with this exact wrapper — the object literal is the JSON file content pasted **verbatim, unmodified** (JSON is valid TS syntax; keep the `$schema` key if present):

```ts
import type { ThemeJson } from "../themeJson.js";

// Ported verbatim from opencode (packages/tui/src/theme/assets/<name>.json).
const theme: ThemeJson = <PASTE JSON CONTENT HERE>;

export default theme;
```

Note: use kebab-case filename `one-dark.ts`; its import binding is `oneDark`.

- [ ] **Step 4: Register them in `src/ui/themes/index.ts`**

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/themes-builtin.test.ts tests/theme.test.ts`
Expected: PASS. If a ported theme fails the distinct `thinking !== user` check in theme.test.ts, that test only iterates for truthiness/distinctness — should hold since `thinking` falls back to `textMuted` and `user` to `secondary`; if a specific theme resolves them identically, add an explicit `"thinking": <another role>` key at the END of that theme's object literal (documented deviation, keep a comment).

- [ ] **Step 6: Verify visually (spot check)**

Run: `npx tsx src/cli.tsx` in a real terminal, then `/theme dracula`, `/theme gruvbox`, `/theme` (lists all 13). Expected: colored output changes, no crash, list shows all names.

- [ ] **Step 7: Commit**

```bash
git add src/ui/themes tests/themes-builtin.test.ts
git commit -m "feat(ui): bundle 10 popular themes ported from opencode"
```

---

### Task 5: Custom user themes in `~/.cloudcode/themes/`

**Files:**
- Modify: `src/ui/theme.ts` (add `loadCustomThemes`)
- Modify: `src/cli.tsx` (call it at startup, before the UI mounts; log warnings to stderr)
- Test: `tests/theme-custom.test.ts` (new)

**Interfaces:**
- Consumes: `registerTheme` (Task 3), `configDir()` from `src/agent/providers.js`.
- Produces: `loadCustomThemes(dir?: string): string[]` — loads every `*.json` in the directory (name = basename without extension, overriding built-ins), returns human-readable warning strings for files it skipped; missing directory is not an error.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/theme-custom.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, loadCustomThemes } from "../src/ui/theme.js";

const themeDir = () => mkdtempSync(join(tmpdir(), "cc-themes-"));

const VALID = JSON.stringify({
  defs: { pop: "#12ab34" },
  theme: { primary: "pop", secondary: "#000001", accent: "pop", text: "#cccccc",
           textMuted: "#777777", error: "#ff0000", success: "#00ff00", warning: "#ffff00" }
});

describe("loadCustomThemes", () => {
  it("returns no warnings for a missing directory", () => {
    expect(loadCustomThemes(join(themeDir(), "nope"))).toEqual([]);
  });

  it("registers a valid custom theme by filename", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "mytheme.json"), VALID);
    expect(loadCustomThemes(dir)).toEqual([]);
    expect(THEMES.mytheme.accent).toBe("#12ab34");
  });

  it("lets a custom theme override a built-in of the same name", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "dark.json"), VALID);
    loadCustomThemes(dir);
    expect(THEMES.dark.accent).toBe("#12ab34");
  });

  it("skips invalid JSON with a warning and keeps loading others", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "broken.json"), "not json{{");
    writeFileSync(join(dir, "good.json"), VALID);
    const warnings = loadCustomThemes(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken.json");
    expect(THEMES.good).toBeDefined();
    expect(THEMES.broken).toBeUndefined();
  });

  it("skips themes with unresolvable references with a warning", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "dangling.json"), JSON.stringify({ theme: { primary: "ghost" } }));
    const warnings = loadCustomThemes(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dangling.json");
  });

  it("ignores non-json files", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "readme.txt"), "hi");
    expect(loadCustomThemes(dir)).toEqual([]);
  });
});
```

CAUTION: the override test mutates the shared `THEMES.dark` for the process; keep this file isolated (vitest runs files in separate workers by default, so this is safe — do not merge these tests into `tests/theme.test.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/theme-custom.test.ts`
Expected: FAIL — `loadCustomThemes` not exported.

- [ ] **Step 3: Implement `loadCustomThemes` in `src/ui/theme.ts`**

Add imports at the top:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../agent/providers.js";
```

Append at the bottom of the file:

```ts
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
      delete THEMES[name];
      warnings.push(`Skipped theme ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return warnings;
}
```

Note the `delete THEMES[name]` guard: if `registerTheme` succeeded for dark but the light validation throws, the half-registered entry is removed. (For a custom theme overriding a built-in this also drops the built-in — acceptable and simpler than snapshot/restore; the warning tells the user why.)

- [ ] **Step 4: Wire into startup in `src/cli.tsx`**

Locate the entry point's setup section (before the UI is constructed). Add:

```ts
import { loadCustomThemes } from "./ui/theme.js";
```

and, as one of the first statements of startup (before any theme name is read):

```ts
// Custom themes must be registered before loadThemeName() validates the
// saved name, or a saved custom theme would silently fall back to dark.
for (const warning of loadCustomThemes()) console.error(warning);
```

If `src/cli.tsx` delegates startup elsewhere (e.g. `nativeApp.ts` bootstrap), put the call wherever `loadThemeName()` is first invoked — strictly before it.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/theme-custom.test.ts tests/theme.test.ts`
Expected: PASS.

- [ ] **Step 6: End-to-end check**

```bash
mkdir -p ~/.cloudcode/themes
```

Create `~/.cloudcode/themes/mytest.json` with the VALID JSON from Step 1, run `npx tsx src/cli.tsx`, then `/theme mytest`. Expected: theme applies; `/theme` lists `mytest`. Delete the file afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/ui/theme.ts src/cli.tsx tests/theme-custom.test.ts
git commit -m "feat(ui): load custom user themes from ~/.cloudcode/themes"
```

---

### Task 6: Full verification and docs

**Files:**
- Modify: `README.md` (if it documents `/theme` or the theme list — check with `grep -n -i theme README.md`)

- [ ] **Step 1: Full test run**

Run: `npx vitest run`
Expected: all suites pass except the known pre-existing failures (skills env pollution, provider flake, stale `.claude/worktrees` globbing — see memory notes). No NEW failures relative to `git stash && npx vitest run` baseline if in doubt.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 3: Real-terminal smoke test (compiled output)**

Run `node dist/cli.js` in Windows Terminal AND in legacy conhost (user tests the compiled exe/conhost path): switch through `/theme dracula`, `/theme light`, `/theme mono`, confirm colors render and nothing emits garbage escape sequences on conhost.

- [ ] **Step 4: Update README if needed, commit any doc change**

```bash
git add README.md
git commit -m "docs: document bundled and custom themes"
```

(Skip the commit if grep showed nothing to update.)
