# Standard-role template dedup for builtin themes design

Date: 2026-08-23

## Goal

Remove the structural duplication across the 13 builtin theme definitions
(~2,100 lines) by deriving the ~30 mechanical roles (markdown*, syntax*,
diff* accents) from each theme's core roles, keeping per-theme data only
where it genuinely deviates. A golden fixture proves resolved output is
byte-identical before and after — zero visual change, guaranteed.

Non-goal: converting themes to `.json` files (authoring symmetry is nice but
saves only ~100 lines; skipped for now).

## Architecture

New module `src/ui/standardRoles.ts`:

```ts
export const STANDARD_ROLES: Record<string, ColorValue>;
// e.g. markdownHeading: { dark: "primary", light: "primary" }
export function withStandardRoles(theme: Record<string, ColorValue>): Record<string, ColorValue>;
```

- Values are references (def names or role names) resolved by the existing
  `resolveThemeJson` — no new resolution logic.
- `withStandardRoles` fills ONLY keys absent from the theme's map; explicit
  keys always win.
- Injection point: `registerTheme()` in `theme.ts` becomes
  `resolveThemeJson(withStandardRoles(json), mode)`. Builtins and user custom
  themes both flow through it.

Deliberate behavior change (documented): a user JSON missing roles now gets
standard-derived colors instead of falling to the gray fallback in `pick()`.
This makes minimal custom themes render completely.

## Per-theme shrink procedure

1. Before any change, generate `tests/fixtures/theme-golden.json` from all
   builtins × dark/light via the current resolver; commit it with a test.
2. For each theme: compare derivation against its current resolved values;
   delete exactly the matching keys; keep mismatches as explicit overrides.
3. Golden test asserts per-key equality after every step.

Themes that deviate a lot simply keep more overrides — correctness first,
line count second. Target: each file ≤ ~90 lines.

## Testing

- `tests/standardRoles.test.ts`: fill-in of missing keys; explicit keys never
  overridden; derived references resolve.
- `tests/themes-golden.test.ts`: golden equality for 13 themes × 2 modes.
- Existing `themes-builtin`, `theme`, `theme-custom` tests pass untouched.

## Migration steps

1. Golden fixture + golden test (green before anything changes).
2. `standardRoles.ts` initial template + unit tests.
3. Wire into `registerTheme` — golden must stay green (fill never overrides).
4. Shrink themes using the comparison output; run goldens per batch.
5. Full gates: lint, lint:size, build, test.

## Risks

- Unknown template coverage up front → measured empirically per theme; the
  golden test guarantees safety regardless of coverage achieved.
