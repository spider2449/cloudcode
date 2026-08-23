# /config interactive picker — design

Date: 2026-08-23

## Problem

`/config` is typed-only: `/config <key> <value>`. Users must know the exact
key names and valid values; a wrong value produces an error message listing
options. Tab completion exists but only helps users who already know to
press Tab. Setting values is harder than it should be.

## Goal

Make `/config` pickable from a list of valid values, while keeping the typed
form working and making its hints more informative.

## Decisions (from brainstorm)

- **UX shape: both.** An interactive picker overlay AND smarter inline hints
  for the typed form.
- **Layout: two-step picker.** Phase 1 lists settings with current values;
  picking one opens phase 2 listing that setting's valid values.
- **Approach A:** new `config` overlay mode following the existing picker
  patterns (`/resume`, `/set project`, `/statusline`). No generic ListPicker
  refactor in this change.

## UX behavior

- `/config` with no arguments opens the picker overlay instead of printing
  the key = value summary.
- **Phase 1 — key list:** all seven keys (`provider`, `model`,
  `permissionMode`, `networkMode`, `theme`, `effort`, `autoMemory`), each row
  showing its current value marked with `●`. Up/Down navigate, Enter selects,
  Esc closes the overlay.
- **Phase 2 — value list:** valid values for the chosen key, current one
  marked `●`. Enter applies; Esc returns to phase 1 (not out of the overlay).
- Applying a value reuses the exact code path as typed
  `/config <key> <value>` today, including its rules:
  - `bypassPermissions` stays session-only and is not persisted;
  - `networkMode` offers only persistable modes (`offlineStrict`,
    `providerOnly`);
  - provider/model switches call `switchProvider` / `setModel`.
- After applying, the existing notice text (`provider = x (saved)`) prints
  and the overlay is closed.
- **Inline hints (typed form):** submitting `/config <key>` without a value
  shows the current value plus the valid options for that key, e.g.
  `theme = dark` followed by `Valid: dark, light, solarized`. The old bare
  `/config` key = value summary is intentionally replaced by the picker;
  phase 1 already shows every key with its current value.

## Components

- `src/ui/widgets/overlay.ts`: new `"config"` entry in `OverlayMode`;
  `ConfigState { phase: "keys" | "values"; key?; index; choices; onApply;
  onCancel }`; `openConfig()`, `handleConfigKey()`, `renderConfig()` — same
  shape as the resume/statusline modes (~120 lines added; file stays under
  the 600-line ceiling).
- `src/ui/appPickers.ts`: new `openConfigPicker(...)` wiring built on
  `PickerDeps`, same open/pick/cancel structure as `openResumePicker`.
- `src/commands/types.ts`: extend `CommandContext` with `openConfigPicker`
  taking the choice data and callbacks.
- `src/commands/builtins.ts`:
  - export a `configChoices(cctx)` helper returning
    `{ key, current, choices }[]` per key, sourcing live values from
    `cctx.providerNames()` / `cctx.availableModels()` so the UI layer never
    duplicates validation lists;
  - refactor the command body into an exported `applyConfigValue(ctx, key,
    value)` used by both typed input and picker picks;
  - add the inline-hint output to the no-value path.
- `src/ui/nativeApp.ts`: implement `ctx.openConfigPicker` via
  `pickerDeps()`, calling `applyConfigValue` on pick.

## Data flow

Choice lists are computed at overlay-open time from live context (same
sources `completeArgs` uses). Picking a value closes the overlay and runs
`applyConfigValue`, which handles persistence + session switch + notice.
If a model list is unavailable for the current provider, phase 2 shows an
"(unavailable)" hint row and Enter does nothing.

## Error handling

Validation lives entirely in `applyConfigValue`. The picker cannot offer
invalid values by construction; if one slips through anyway (e.g. the
provider set changed mid-session), the existing error-notice path fires and
the overlay stays closed. No new try/catch boundaries are added, per AGENTS.md.

## Testing

- Existing builtins test file: `applyConfigValue` unit tests covering each
  key's accept/reject rules, inline-hint output, and the bypassPermissions
  session-only rule.
- Overlay tests: config-mode key navigation, phase transitions (Esc from
  values returns to keys; Esc on keys closes), render output including `●`
  markers.
- Tests land in the same commit as the feature (repo convention).

## Out of scope

- Generic reusable ListPicker extraction (approach B) — revisit if a fourth
  list-style overlay is added.
- New settings keys or new valid values for existing keys.
