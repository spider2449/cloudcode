# /effort Command Design

**Date:** 2026-07-14
**Status:** Approved

## Goal

Add an `/effort` command that controls extended-thinking (reasoning) effort for the
agent by mapping named levels to Anthropic Messages API thinking budgets, with the
thinking stream rendered as dim text in the TUI.

## Semantics

`/effort <off|low|medium|high>`

| Level  | `thinking.budget_tokens` |
|--------|--------------------------|
| off    | disabled (no `thinking` param) |
| low    | 4,096  |
| medium | 16,384 |
| high   | 32,768 |

- Default level is `off` — behavior is unchanged until the user opts in.
- No argument: list the levels with the current one marked `●` (same UX as `/model`).
- `completeArgs` completes the level names.
- The setting persists via `saveSetting("effort", ...)` and is also exposed as a
  `/config` key. Applied live through `ctx.setEffort()` →
  `AgentSession.setEffort()` → `EngineLoop.setEffort()` (mirrors `setModel`).

## Components

### Settings (`src/agent/settings.ts`)
- Add `effort?: EffortLevel` to `Settings`; validate on load (only known level
  strings accepted, invalid values ignored).

### Command (`src/commands/builtins.ts`)
- New `effort` command per semantics above.
- Add `effort` to `CONFIG_KEYS` in `/config`, with value completion.
- New `CommandContext` members: `setEffort(level)`, `currentEffort()`.

### Engine (`src/engine/loop.ts`, `src/engine/api.ts`)
- `EngineLoop` holds the current effort level; `setEffort()` updates it.
- When effort ≠ off, the stream request adds
  `thinking: { type: "enabled", budget_tokens }` and raises `max_tokens` to
  `budget + MAX_TOKENS` so the visible answer is not squeezed out.
- `StreamRequest` gains an optional `thinking` field.
- Stream handling supports thinking blocks:
  - `content_block_start` with `type: "thinking"` starts a thinking block.
  - `thinking_delta` appends thinking text and emits a new engine message so the
    UI can stream it.
  - `signature_delta` accumulates the signature onto the block.
- Thinking blocks (including signature) are preserved in assistant message
  history — required by the API for subsequent turns with tool use.
- Compaction and session save/load carry thinking blocks through untouched.

### UI
- New engine message for thinking deltas renders as dim/gray streaming text,
  visually distinct from the final answer text, in both the React renderer and
  the term renderer.

## Error Handling

- Providers that reject the `thinking` parameter surface the API error through
  the existing error-result path; remedy is `/effort off`.
- Invalid persisted values are ignored on load (fall back to `off`).

## Testing

- Command tests (`tests/commands.test.ts`): arg parsing, level listing, unknown
  level message, completion, persistence via `saveSetting`.
- Loop tests: fake stream emitting `thinking` blocks/deltas/signature — verify
  history retains the blocks, UI messages are emitted, and the request contains
  the `thinking` param with correct `budget_tokens` and adjusted `max_tokens`.
- Settings tests: `effort` round-trips and invalid values are rejected.
