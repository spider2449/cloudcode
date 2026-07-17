# Theme System Overhaul — Design

Date: 2026-07-17
Status: Approved

## Goal

Replace cloudcode's 3 hard-coded named-ANSI-color themes with an
opencode-compatible theme system: JSON theme files with hex/truecolor
support, ~10 popular bundled themes, and user-defined custom themes.

Reference: https://github.com/anomalyco/opencode/tree/dev/packages/tui/src/theme

## Current state

- `src/ui/theme.ts`: `Theme` interface with 8 roles (`user`, `accent`,
  `muted`, `error`, `success`, `removed`, `warning`, `thinking`), 3 themes
  (`dark`, `light`, `mono`) using named ANSI colors.
- `src/ui/term/ansi.ts` `sgr()`: maps 9 color names to basic SGR codes
  (30–37, 90). No 256-color or truecolor support.
- Theme selection saved via `loadSettings`/`saveSetting` (`theme` key in
  `~/.cloudcode/settings.json`), applied through `/theme` command
  (`src/commands/builtins.ts`) and consumed by both the Ink UI and the
  native TUI (`layout.ts`, `widgets/*`, `term/render.ts`).
- Markdown is styled by `marked-terminal` (`src/ui/markdown.ts`), so
  markdown/syntax color roles are not needed in the app `Theme`.

## Design

### 1. Theme format: opencode JSON schema, verbatim

Each theme is a JSON file with:

- `defs`: named palette entries (hex strings).
- `theme`: role name → color value, where a value is one of:
  - hex string (`"#bd93f9"`)
  - ANSI color number 0–255
  - reference to a `defs` name or another theme key
  - `{ "dark": <value>, "light": <value> }` variant object
  - `"none"` (no color)

Keeping the schema identical to opencode means theme files copy over
unchanged and future themes drop in for free.

Bundled themes live in `src/ui/themes/*.json`:
dracula, catppuccin, gruvbox, tokyonight, nord, one-dark, solarized,
rosepine, github, monokai — plus `dark.json`, `light.json`, `mono.json`
rewritten in the same schema so there is a single code path.

### 2. Resolution layer (`src/ui/theme.ts`)

- `resolveTheme(json: ThemeJson, mode: "dark" | "light"): Theme` —
  recursively resolves refs, hex, and ANSI numbers to RGB; picks the
  `dark`/`light` variant per `mode`. Detects and rejects dangling or
  circular references.
- `ansiToRgb(n)` — standard 16, 6×6×6 cube (16–231), grayscale (232–255).
- The app `Theme` interface keeps the existing 8 role names as the
  consumed surface, mapped from opencode roles:
  - `user` ← `secondary`, `accent` ← `accent` (fallback `primary`),
    `muted` ← `textMuted`, `error` ← `error`, `success` ← `success`,
    `removed` ← `diffRemoved` (fallback `error`), `warning` ← `warning`,
    `thinking` ← `textMuted`-derived (or explicit key when present).
  - All other resolved keys are retained on the object (indexed access)
    so future widgets can consume them without schema changes.
- `Theme` values become RGB objects (or resolved color tokens) instead of
  ANSI name strings.

### 3. Color emission (`src/ui/term/ansi.ts`)

- `sgr()` accepts the new color values and emits:
  - truecolor `ESC[38;2;r;g;bm` when supported,
  - else nearest 256-color `ESC[38;5;nm`,
  - else nearest basic-16 code.
- Capability detection: `COLORTERM=truecolor|24bit` → truecolor;
  Windows 10+ conhost/Windows Terminal → truecolor (conhost supports
  24-bit SGR); dumb/unknown terminals degrade.
- Legacy color names (`"blue"`, `"gray"`, …) keep working during the
  transition so widgets can migrate incrementally.
- No OSC background-color query is sent on conhost (known quirk area);
  background detection is capability-gated.

### 4. Selection and mode

- Theme choice remains an explicit saved setting; `/theme` lists all
  discovered themes (bundled + custom).
- Variant mode: each theme resolves with its natural mode (`dark` by
  default); terminal-background detection is used only where supported to
  choose the variant for themes that define both, with `dark` as the
  safe fallback.

### 5. Custom themes

- User themes: `~/.cloudcode/themes/*.json`, same schema.
- Discovered at startup; theme name = filename (sans `.json`).
- A custom theme with the same name as a built-in overrides it.
- Invalid JSON or unresolvable themes are skipped with a warning, never
  crash startup.

### 6. Testing

Extend `tests/theme.test.ts`:

- Resolution: hex, ANSI numbers (all three ranges), `defs` refs, nested
  refs, dark/light variants, `none`, dangling-ref error.
- Downgrade: truecolor → 256 → 16 nearest-color mapping.
- Every bundled JSON resolves cleanly in both modes.
- Custom theme discovery, name override, and invalid-file skip.
- Existing consumers (`layout`, widgets, render) still colorize output
  (snapshot/SGR-presence checks).

## Out of scope

- Porting opencode's 50+ role surface into typed interface members
  (extra keys are resolved and retained, not wired to widgets).
- Syntax/markdown theming (handled by marked-terminal).
- Live OSC-based background watching.
