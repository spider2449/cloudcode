# Status Bar: providers.json Model + Effort Segment

Date: 2026-07-21

## Problem

The TUI status bar's model label prefers `settings.model` (the `--model` /
`/config model` override) over the selected provider's `model` in
`providers.json`. Users treating `providers.json` as the source of truth see a
stale or mismatched model name. Reasoning effort is not shown at all.

## Goals

1. The status bar model label reflects the selected provider's `model` from
   `providers.json` ("providers.json wins").
2. Reasoning effort is always shown as its own status-bar segment, including
   when it is `off`.

## Design

### Model source — providers.json wins

Simplify `NativeApp.modelFor()` so `providers.json` is the single source of
truth for the interactive TUI:

```ts
private modelFor(name: string): string | undefined {
  return this.props.providers[name]?.model;
}
```

This drops the `initialModel` (`settings.model`) priority. Because `modelFor`
also feeds `createSession` (the model actually sent to the API), the label and
the request stay consistent. The existing `model → servedModel` arrow still
surfaces any runtime difference the API reports.

- `/model X` (`setModel`) still works as a live runtime override — it assigns
  `this.model` directly and is unaffected.
- `settings.model` / `--model` no longer influences the interactive TUI's model
  (providers.json is authoritative there). It continues to drive print mode.

### Effort segment — always shown

- Add `effort: string` to `StatusBarProps`.
- In `renderStatusBar`, push `effort: <level>` as its own segment immediately
  after the provider/model segment.
- In `NativeApp.recompute()`, pass `effort: this.effort` into `statusBarProps`.
  `this.effort` is already kept live via `setEffort`.

Example row:

```
anthropic/claude-opus-4-8 · effort: high · default · ⎇ master · …
```

## Testing

- `tests/widgets.test.ts`: assert the effort segment renders (including `off`)
  and that the model label comes from the provided `model` prop.

## Non-goals

- Changing print-mode model resolution.
- Changing `providers.json` schema or the `/model` override mechanism.
