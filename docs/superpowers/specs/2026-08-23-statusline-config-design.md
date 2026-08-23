# Design: Configurable Status Line

Date: 2026-08-23
Status: Approved (pending spec review)

## Summary

Let users choose which segments appear in the bottom status line via a
`/statusline` picker overlay. The choice persists in
`~/.cloudcode/settings.json` and applies live.

## Decisions made during brainstorming

- Configuration UI: interactive picker overlay opened by `/statusline`
  (arrow keys + enter), following the existing memory-picker pattern.
- Scope: every existing segment is toggleable. No new segment types in this
  change.
- Default when unset: curated minimal set - `model · mode · branch · tokens`.
- Approach: item-ID list stored as one settings array (Approach A), chosen
  over a boolean map (fixed order) and a free-form template string (parser
  complexity, YAGNI).

## Item registry

New module `src/statusLineItems.ts` with no imports, safe for both the
`agent/` and `ui/` layers:

```ts
export const STATUS_LINE_ITEMS = [
  "model", "servedModel", "effort", "mode",
  "network", "branch", "tokens", "cost", "elapsed", "cwd",
] as const;
export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];
export const DEFAULT_STATUS_LINE_ITEMS: StatusLineItem[] =
  ["model", "mode", "branch", "tokens"];
```

The constant lives outside `src/ui/` because `src/agent/settings.ts` must
validate against it without importing UI code (per the layering rules in
AGENTS.md).

## Settings (`src/agent/settings.ts`)

- New optional field on `Settings`: `statusLineItems?: string[]`.
- Validation in `loadSettings`: accept only arrays of strings; drop entries
  not in `STATUS_LINE_ITEMS`; remove duplicates; preserve user ordering. A
  non-array or other invalid shape means the field is ignored and the default
  applies. Corrupt file falls back to the whole-file `{}` default (existing
  behavior, unchanged).
- Widen `saveSetting`'s value parameter from `string | boolean` to
  `string | boolean | string[]`. Merge-with-raw semantics stay: unknown keys
  survive a save.

## Rendering (`src/ui/widgets/statusBar.ts`)

- `StatusBarProps` gains an optional `items?: StatusLineItem[]`.
- Segment construction moves into a `Record<StatusLineItem, () => string | null>`
  map. Returning null omits the segment (no git repo for branch, zero cost,
  missing optional fields, etc.). `renderStatusBar` iterates the effective
  list (`props.items ?? DEFAULT_STATUS_LINE_ITEMS`), emits only non-null
  segments joined with the existing separator, then packs them into rows of
  terminal width exactly as today.
- Output for any given enabled set matches what today's fixed sequence would
  produce for the same segments; only membership changes, not formatting.
- Empty item list renders as an empty bar (the bar still occupies its footer
  row slot).

## Picker overlay (`src/ui/widgets/overlay.ts`, `src/ui/appPickers.ts`)

- New `OverlayMode` entry `"statusline"` with state:
  `items: StatusLineItem[]`, `enabled: Set<StatusLineItem>`,
  `cursor: number`.
- `openStatusLine(items, currentlyEnabled, onDone)`: up/down move the cursor;
  enter/space toggles the highlighted item and calls back immediately; esc
  closes.
- Each toggle invokes `onDone(nextList)` where `nextList` is the enabled IDs
  in canonical `STATUS_LINE_ITEMS` order (display order follows the registry,
  not toggle order - the overlay stays stateless about ordering).
- Wired via `appPickers.ts`: `openStatusLinePicker(deps, initial, onChange)`
  mirroring `openMemoryPicker`, including cancel handling on esc.

## Command surface (`src/commands/builtins.ts`, `src/commands/types.ts`)

- New `/statusline` builtin: any invocation opens the picker; arguments are
  not accepted this iteration (extra args print a short usage hint instead of
  opening the picker). Tab completion offers nothing beyond the bare command.
- New `CommandContext` method
  `openStatusLinePicker(current: StatusLineItem[]): void`, implemented in
  `nativeApp.ts`'s `buildCommandContext()`.

## Data flow / live application (`src/ui/nativeApp.ts`)

1. `App` constructor loads
   `this.statusLineItems = loadSettings().statusLineItems ??
   DEFAULT_STATUS_LINE_ITEMS` alongside the existing effort/theme reads.
2. `recompute()` passes `items: this.statusLineItems` into `statusBarProps`.
3. Overlay toggle callback: `saveSetting("statusLineItems", next)` ->
   update `this.statusLineItems` -> `recompute()`. Same pattern as `/theme`.

## Error handling

- Corrupt or unrecognized setting values fall back to defaults per the
  existing config-loader rule (settings.ts wraps its own read/parse).
- Toggle callbacks run inside the overlay's normal flow; the command body
  needs no try/catch because slash-command dispatch already has the single
  boundary catch in `nativeApp.ts` (per AGENTS.md).

## Testing

- `tests/statusLineItems.test.ts` (new): registry shape, default set,
  validation helper behavior if extracted.
- `tests/settings.test.ts`: round-trip array save/load, unknown-ID entries
  dropped, duplicates removed, non-array ignored, unknown sibling keys
  preserved on save.
- `tests/widgets.test.ts`: filtered segments render in registry order,
  omitted items produce no stray separators, default set used when `items`
  absent, empty list renders empty, null-yielding segments skipped.
- `tests/overlay.test.ts`: statusline mode key handling (up/down/enter/
  space/esc), toggle updates state and fires callback with canonical-order
  list, render shows enabled/disabled markers.
- `tests/appPickers.test.ts` / `tests/commands.test.ts`: `/statusline` opens
  the picker; toggle persists via `saveSetting` and recomputes.

## Out of scope

- Custom/free-text format templates.
- New segment types (session name, clock, etc.).
- Reordering items independently of the registry order (the picker toggles
  visibility; order is fixed by the registry).
