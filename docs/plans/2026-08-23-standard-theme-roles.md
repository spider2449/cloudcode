# Standard Theme Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the mechanical theme roles (markdown*/syntax*/diff*) from each theme's core roles so builtin definitions shrink dramatically, with golden fixtures proving zero visual change.

**Architecture:** New `src/ui/standardRoles.ts` holds a `STANDARD_ROLES` reference-based template plus `withStandardRoles()` which fills only missing keys; `registerTheme()` applies it before resolution. A committed golden fixture pins current resolver output; a comparison script drives which keys each theme may delete.

**Tech Stack:** TypeScript (strict), vitest, tsx for dev scripts.

## Global Constraints

- All code, comments, identifiers in English.
- No `any`, no non-null `!`; `strict` stays true.
- Golden safety net: after Task 2, EVERY subsequent task must keep `npx vitest run tests/themes-golden.test.ts` green.
- Explicit theme keys always win over template derivation.
- After all tasks: `npm run lint && npm run lint:size && npm run build && npm test`.

## Evidence base (measured across all 13 builtins, both modes)

Roles matching a core-role reference in N of 13 themes:

```text
diffAdded: success (11)          diffContextBg: backgroundPanel (10)
markdownListItem: primary (10)   markdownText: text (9)
markdownCodeBlock: text (9)      syntaxComment: textMuted (9)
diffContext: textMuted (8)       diffHighlightAdded: success (8)
diffHighlightRemoved: error (8)  markdownCode: success (8)
markdownEmph: warning (8)        syntaxPunctuation: text (8)
markdownBlockQuote: textMuted (7)  markdownListEnumeration: accent (7)
```

Only these 15 rules enter `STANDARD_ROLES`. Weaker matches (syntaxKeyword,
markdownHeading, … at ≤6/13) stay explicit per-theme data. Three themes
(dark/light/mono) lack most of these roles entirely; the template fills them
harmlessly (they only feed `pick()` fallbacks already pointing at the same
core roles).

---

### Task 1: Golden fixture and golden test

**Files:**
- Create: `scripts/generate-theme-golden.ts` (dev tool, run via tsx)
- Create: `tests/fixtures/theme-golden.json`
- Test: `tests/themes-golden.test.ts`

**Interfaces:**
- Produces: fixture shape `{ [themeName]: { dark: Record<string,string>, light: Record<string,string> } }`; test helper contract used by later tasks.

- [ ] **Step 1: Write the generator**

Create `scripts/generate-theme-golden.ts`:

```ts
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
```

Run: `npx tsx scripts/generate-theme-golden.ts`
Expected: `wrote goldens for 13 themes`.

- [ ] **Step 2: Write the golden test**

Create `tests/themes-golden.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";
import { resolveThemeJson } from "../src/ui/themeJson.js";

// Pins current resolver output for all builtins in both modes. During the
// standard-roles refactor this must never regress: existing keys keep their
// exact value; NEW keys must equal the template derivation (checked once the
// template exists — see the second test).
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
```

Note the subset-equality semantics chosen up front: when the template later
fills roles into the three minimal themes, newly appearing keys do not fail
this test, while any changed existing value does.

- [ ] **Step 3: Run the golden test**

Run: `npx vitest run tests/themes-golden.test.ts`
Expected: PASS (nothing changed yet — this is the baseline).

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-theme-golden.ts tests/fixtures/theme-golden.json tests/themes-golden.test.ts
git commit -m "test(ui): pin golden resolver output for builtin themes"
```

---

### Task 2: Standard roles module

**Files:**
- Create: `src/ui/standardRoles.ts`
- Test: `tests/standardRoles.test.ts`

**Interfaces:**
- Consumes: `ColorValue` from `../themeJson.js`.
- Produces (used by Task 3+):
  - `STANDARD_ROLES: Record<string, ColorValue>` — the 14 evidence-based rules
  - `withStandardRoles(theme: Record<string, ColorValue>): Record<string, ColorValue>`

- [ ] **Step 1: Write the failing tests**

Create `tests/standardRoles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { STANDARD_ROLES, withStandardRoles } from "../src/ui/standardRoles.js";
import { resolveThemeJson, type ThemeJson } from "../src/ui/themeJson.js";

describe("STANDARD_ROLES", () => {
  it("contains exactly the evidence-based rules", () => {
    expect(Object.keys(STANDARD_ROLES).sort()).toEqual([
      "diffAdded", "diffContext", "diffContextBg", "diffHighlightAdded",
      "diffHighlightRemoved", "diffRemoved", "markdownBlockQuote",
      "markdownCode", "markdownCodeBlock", "markdownEmph",
      "markdownListEnumeration", "markdownListItem", "markdownText",
      "syntaxComment", "syntaxPunctuation"
    ]);
  });

  it("values resolve through references for both modes", () => {
    const json: ThemeJson = {
      defs: { brand: "#123456" },
      theme: { primary: "brand", success: "brand", ...withStandardRoles({}) }
    };
    expect(resolveThemeJson(json, "dark").markdownListItem).toBe("#123456");
    expect(resolveThemeJson(json, "light").diffAdded).toBe("#123456");
  });
});

describe("withStandardRoles", () => {
  const core = { primary: "#111111", success: "#222222", error: "#333333" };

  it("fills missing keys with the template", () => {
    const out = withStandardRoles(core);
    expect(out.diffAdded).toEqual({ dark: "success", light: "success" });
    expect(out.syntaxComment).toEqual({ dark: "textMuted", light: "textMuted" });
  });

  it("never overrides an explicit key", () => {
    const explicit = { ...core, diffAdded: { dark: "primary", light: "primary" } };
    const out = withStandardRoles(explicit);
    expect(out.diffAdded).toEqual({ dark: "primary", light: "primary" });
  });

  it("does not mutate its input", () => {
    const input = { ...core };
    withStandardRoles(input);
    expect(input).toEqual(core);
  });
});
```

Then verify the second test compiles against the final template — it already
matches the 15-entry implementation below.

Run: `npx vitest run tests/standardRoles.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

Create `src/ui/standardRoles.ts`:

```ts
import type { ColorValue } from "./themeJson.js";

/**
 * Standard mapping from a theme's core roles onto the mechanical roles.
 * Each value is expressed as references so the existing resolver handles
 * def indirection and mode selection. Evidence: across the 13 builtins,
 * both mode values equal the referenced core role in at least 7 of 13
 * themes; weaker patterns stay explicit per theme.
 */
export const STANDARD_ROLES: Record<string, ColorValue> = {
  diffAdded: { dark: "success", light: "success" },
  diffRemoved: { dark: "error", light: "error" },
  diffContext: { dark: "textMuted", light: "textMuted" },
  diffContextBg: { dark: "backgroundPanel", light: "backgroundPanel" },
  diffHighlightAdded: { dark: "success", light: "success" },
  diffHighlightRemoved: { dark: "error", light: "error" },
  markdownBlockQuote: { dark: "textMuted", light: "textMuted" },
  markdownCode: { dark: "success", light: "success" },
  markdownCodeBlock: { dark: "text", light: "text" },
  markdownEmph: { dark: "warning", light: "warning" },
  markdownListEnumeration: { dark: "accent", light: "accent" },
  markdownListItem: { dark: "primary", light: "primary" },
  markdownText: { dark: "text", light: "text" },
  syntaxComment: { dark: "textMuted", light: "textMuted" },
  syntaxPunctuation: { dark: "text", light: "text" }
};
// 15 entries — must match tests/standardRoles.test.ts's expected key list.

/** Returns the theme map extended with the standard derivation for every
 * key it does not already declare. Explicit keys always win; the input is
 * not mutated. */
export function withStandardRoles(theme: Record<string, ColorValue>): Record<string, ColorValue> {
  const out = { ...theme };
  for (const [key, value] of Object.entries(STANDARD_ROLES)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}
```

Then fix the first unit test's expected key list to match exactly (15 names,
sorted alphabetically):

```ts
expect(Object.keys(STANDARD_ROLES).sort()).toEqual([
  "diffAdded", "diffContext", "diffContextBg", "diffHighlightAdded",
  "diffHighlightRemoved", "diffRemoved", "markdownBlockQuote",
  "markdownCode", "markdownCodeBlock", "markdownEmph",
  "markdownListEnumeration", "markdownListItem", "markdownText",
  "syntaxComment", "syntaxPunctuation"
]);
```

And simplify the second test to use a role that exists in the template:

```ts
it("values resolve through references for both modes", () => {
  const json: ThemeJson = {
    defs: { brand: "#123456" },
    theme: { primary: "brand", success: "brand", ...withStandardRoles({}) }
  };
  expect(resolveThemeJson(json, "dark").markdownListItem).toBe("#123456");
  expect(resolveThemeJson(json, "light").diffAdded).toBe("#123456");
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/standardRoles.test.ts tests/themes-golden.test.ts`
Expected: PASS both.

- [ ] **Step 4: Commit**

```bash
git add src/ui/standardRoles.ts tests/standardRoles.test.ts
git commit -m "feat(ui): standard role template for theme definitions"
```

---

### Task 3: Wire into registerTheme

**Files:**
- Modify: `src/ui/theme.ts` (`registerTheme`, ~line 51)
- Test: extend `tests/theme-custom.test.ts`

**Interfaces:**
- Consumes: `withStandardRoles` from Task 2.
- Produces: all theme registration paths (builtins and user JSONs) derive missing roles.

- [ ] **Step 1: Write the failing test**

Add to `tests/theme-custom.test.ts`:

```ts
it("a minimal custom theme gets standard-derived roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "theme-minimal-"));
  writeFileSync(join(dir, "mini.json"), JSON.stringify({
    theme: {
      primary: "#ff0000", secondary: "#00ff00", accent: "#0000ff",
      error: "#ff0011", warning: "#fff000", success: "#00ff11", info: "#000fff",
      text: "#eeeeee", background: "#101010"
    }
  }));
  loadCustomThemes(dir);
  expect(THEMES["mini"]).toBeDefined();
  // markdownListItem derives from primary through the standard template.
  expect(THEMES["mini"]["markdownListItem"]).toBe("#ff0000");
});
```

(Match the file's existing imports for `mkdtempSync/writeFileSync/tmpdir/join/loadCustomThemes/THEMES`; reuse whatever setup/teardown pattern the file already uses around `THEMES` mutation.)

Run: `npx vitest run tests/theme-custom.test.ts`
Expected: FAIL — `markdownListItem` is undefined (no template wired).

- [ ] **Step 2: Implement**

In `src/ui/theme.ts` update the import and `registerTheme`:

```ts
import { withStandardRoles } from "./standardRoles.js";

export function registerTheme(name: string, json: ThemeJson, mode?: ThemeMode): void {
  THEMES[name] = toAppTheme(
    resolveThemeJson(withStandardRolesApplied(json), mode ?? BUILTIN_MODES[name] ?? "dark")
  );
}
```

Simplest correct wiring — apply inside `registerTheme` only, leaving
`resolveThemeJson` untouched everywhere else. Because callers pass either a
full `ThemeJson` (defs + theme), wrap just the map:

```ts
import { withStandardRoles } from "./standardRoles.js";

export function registerTheme(name: string, json: ThemeJson, mode?: ThemeMode): void {
  const effective: ThemeJson = { ...json, theme: withStandardRoles(json.theme) };
  THEMES[name] = toAppTheme(resolveThemeJson(effective, mode ?? BUILTIN_MODES[name] ?? "dark"));
}
```

Note: `loadCustomThemes` also validates the light variant via a direct
`resolveThemeJson(json, "light")` call — update that line to resolve the same
effective object so validation covers what registration uses:

```ts
resolveThemeJson({ ...json, theme: withStandardRoles(json.theme) }, "light");
```

Also update the comment above `loadCustomThemes` in `theme.ts` so the
deliberate behavior change is documented where users will read it:

```ts
// Loads user theme files from <configDir>/themes/*.json. Theme name is the
// filename without extension; a custom theme overrides a built-in of the
// same name. Roles a file does not declare are filled from the standard
// role template (see standardRoles.ts), so a minimal theme renders fully
// instead of falling back to gray. Broken files are skipped with a warning
// so a bad theme can never prevent startup.
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/theme-custom.test.ts tests/themes-golden.test.ts tests/theme.test.ts tests/themes-builtin.test.ts`
Expected: ALL PASS — golden stays green because filling only ADDS keys for
themes that lacked them and never alters existing values.

- [ ] **Step 4: Commit**

```bash
git add src/ui/theme.ts tests/theme-custom.test.ts
git commit -m "feat(ui): derive standard roles at theme registration"
```

---

### Task 4: Comparison script

**Files:**
- Create: `scripts/compare-theme-roles.ts` (dev tool)

**Interfaces:**
- Consumes: `STANDARD_ROLES`, `withStandardRoles` from Task 2.
- Produces: per-theme report of which keys may be deleted (derivation matches current) and which must stay.

- [ ] **Step 1: Write the script**

Create `scripts/compare-theme-roles.ts`:

```ts
import { BUILTIN_THEME_JSONS } from "../src/ui/themes/index.js";
import { resolveThemeJson } from "../src/ui/themeJson.js";
import { STANDARD_ROLES } from "../src/ui/standardRoles.js";

for (const [name, json] of Object.entries(BUILTIN_THEME_JSONS)) {
  const deletable: string[] = [];
  for (const key of Object.keys(STANDARD_ROLES)) {
    if (json.theme[key] === undefined) continue;
    const effective = resolveThemeJson({ ...json, theme: { [key]: json.theme[key] } }, "dark");
    const derived = resolveThemeJson({ ...json, theme: { [key]: STANDARD_ROLES[key] } }, "dark");
    const effectiveLight = resolveThemeJson({ ...json, theme: { [key]: json.theme[key] } }, "light");
    const derivedLight = resolveThemeJson({ ...json, theme: { [key]: STANDARD_ROLES[key] } }, "light");
    if (effective[key] === derived[key] && effectiveLight[key] === derivedLight[key]) {
      deletable.push(key);
    }
  }
  console.log(`${name}: delete ${deletable.length} -> ${deletable.join(", ")}`);
}
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/compare-theme-roles.ts`
Expected: one line per theme listing deletable keys. Record the totals —
these drive Task 5. If a theme lists 0 deletable keys, it simply keeps its
explicit data (correctness first).

- [ ] **Step 3: Commit**

```bash
git add scripts/compare-theme-roles.ts
git commit -m "chore(scripts): per-theme standard-role comparison tool"
```

---

### Task 5: Shrink the theme files

**Files:**
- Modify: all files listed by the comparison output, i.e. a subset of
  `src/ui/themes/{dracula,catppuccin,tokyonight,gruvbox,nord,one-dark,solarized,rosepine,github,monokai}.ts`

**Procedure (per batch of 3–4 themes):**

1. For each theme in the batch, delete exactly the keys the comparison
   script listed as deletable — nothing more. Keys NOT listed stay explicit;
   keys absent from the report because the theme never declared them stay
   absent.
2. Keep each file's structure otherwise intact: `$schema`, `defs`, remaining
   `theme` entries, the trailing `export default theme;`.
3. Run: `npx vitest run tests/themes-golden.test.ts tests/standardRoles.test.ts`
   Expected: PASS. Any failure means a key was deleted whose derivation does
   not match — restore that key as an explicit entry and re-run.
4. Check size: `npm run lint:size` — no warnings for theme files.
5. Commit the batch:

```bash
git add src/ui/themes/
git commit -m "refactor(ui): derive standard roles in <batch> themes"
```

Batches: (dracula, catppuccin, tokyonight), (gruvbox, nord, one-dark),
(solarized, rosepine), (github, monokai). Do NOT touch dark/light/mono —
they have no deletable keys (they never declared these roles).

Acceptance: total lines across `src/ui/themes/*.ts` drops well below the
current ~2,100 (expected roughly 40–60% reduction based on the evidence
table); golden tests green throughout.

---

### Task 6: Full gates

- [ ] Run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```

Expected: all clean (the two pre-existing warnings in
`tests/lsp/autoInject.test.ts` are out of scope).

- [ ] Final commit if anything outstanding:

```bash
git status --short
```
