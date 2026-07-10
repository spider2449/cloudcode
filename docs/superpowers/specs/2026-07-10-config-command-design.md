# /config Command — Design

Date: 2026-07-10

## Goal

Add a `/config <key> [value]` builtin that reads and writes persisted startup defaults, so
provider, model, permission mode, and theme survive restarts.

## Background

cloudcode already has per-setting commands (`/provider`, `/model`, `/permissions`, `/theme`), but
only the theme persists. `src/cli.tsx` hardcodes the `--provider` default to `"anthropic"` and has
no way to persist a default model or permission mode.

## Design

### Settings module — `src/agent/settings.ts`

Follows the `theme.ts` / `history.ts` persistence pattern:

- `interface Settings { provider?: string; model?: string; permissionMode?: PermissionMode }`
- Persisted to `~/.cloudcode/settings.json`. Theme is deliberately NOT stored here — it stays in
  `theme.json`; `/config theme` delegates to the existing `loadThemeName`/`saveThemeName`.
- `loadSettings(filePath?): Settings` — missing/corrupt file or non-object → `{}`; drops
  non-string fields and invalid permissionMode values.
- `saveSetting(key, value, filePath?): void` — read-modify-write of settings.json.

### /config builtin

Keys: `provider`, `model`, `permissionMode`, `theme`.

- `/config` — lists all four keys with persisted values, `(unset)` where absent (theme always has
  a value; it falls back to `dark`).
- `/config <key>` — shows that key's persisted value.
- `/config <key> <value>` — validates, persists, and applies to the live session:
  - `provider`: must be in `ctx.providerNames()`; persists then `ctx.switchProvider(value)`.
  - `model`: free-form; persists then `ctx.setModel(value)`.
  - `permissionMode`: one of `default | acceptEdits | bypassPermissions`; persists then
    `ctx.setPermissionMode(value)`.
  - `theme`: must be a key of `THEMES`; delegates to `ctx.setTheme(value)` (which persists to
    theme.json) — nothing written to settings.json.
- Unknown key → notice listing valid keys. Invalid value → notice listing valid values.
- `completeArgs`: completes key names for the first token; for `provider`, `permissionMode`, and
  `theme`, completes valid values for the second token.
- No `CommandContext` changes: persistence is imported directly by the builtin; live-apply reuses
  existing ctx methods.

### Startup wiring — `src/cli.tsx` and `src/ui/App.tsx`

- `cli.tsx` calls `loadSettings()`. The `--provider` flag default changes from `"anthropic"` to
  undefined; effective provider = flag value ?? `settings.provider` ?? `"anthropic"`.
- `App` gains optional props `initialModel?: string` and `initialMode?: PermissionMode` seeded
  from settings in `cli.tsx`:
  - `initialModel` overrides the provider's default model for the initial `model` state and the
    session's `model` option.
  - `initialMode` seeds the `mode` state (default `"default"`), and is used as the initial
    session's `permissionMode`.

## Error Handling

- Corrupt or missing settings.json never crashes startup; it yields `{}`.
- A persisted provider unknown to providers.json: `cli.tsx` validates the effective provider as it
  does today and exits with the existing error message (flag) — for a stale persisted provider it
  falls back to `"anthropic"` with a stderr warning instead of exiting.

## Testing

- `tests/settings.test.ts`: round-trip, missing/corrupt fallback, invalid-shape filtering,
  read-modify-write preserving other keys.
- `tests/commands.test.ts`: `/config` list output, single-key get, set-per-key (persist + ctx call
  assertions with the settings module mocked via `vi.mock`), unknown key, invalid value, completion of keys and
  values.
- Existing app/cli behavior stays green; `initialModel`/`initialMode` props covered by app tests
  if present, otherwise by the builtins/settings tests.
