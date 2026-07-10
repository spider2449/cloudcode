# /compact, /init, and /theme Commands — Design

Date: 2026-07-10

## Goal

Add three missing built-in slash commands to cloudcode: `/compact`, `/init`, and `/theme`.

## Background

cloudcode is an Ink TUI on top of `@anthropic-ai/claude-agent-sdk`. Built-in commands live in
`src/commands/builtins.ts` and receive a `CommandContext` (`src/commands/types.ts`). UI colors are
currently hardcoded string literals (`"cyan"`, `"gray"`, …) across the components in `src/ui/`.

## Design

### /compact and /init — forward to the SDK

The Agent SDK's underlying CLI already implements both commands: `/compact` summarizes the
conversation to shrink context; `/init` analyzes the codebase and generates CLAUDE.md. The
builtins forward the literal command text via the existing `ctx.sendPrompt(...)`:

- `/compact` → `ctx.sendPrompt("/compact")`
- `/init` → `ctx.sendPrompt("/init")`

No changes to `AgentSession` or `CommandContext` are required. Reimplementing either locally was
rejected as needless duplication of SDK behavior.

### /theme — named presets

**Theme module** — new `src/ui/theme.ts`:

- `Theme` interface with semantic slots: `accent`, `muted`, `user`, `error`, `success`,
  `removed`, `warning`.
- Three presets: `dark` (the current hardcoded colors), `light`, `mono`.
- `loadTheme()` / `saveTheme(name)` persisting the chosen preset name to `theme.json` in the
  existing config dir (same dir as `history.json`). Corrupt or missing file falls back to `dark`.

**React integration** — `ThemeProvider` context plus a `useTheme()` hook. All hardcoded color
literals in `MessageList`, `StatusBar`, `InputBox`, `SuggestionMenu`, `ResumePicker`,
`PermissionDialog`, and `WorkingIndicator` migrate to theme slots.

**Command** — builtin `/theme`:

- No args: list available themes, marking the active one.
- `/theme <name>`: switch at runtime and persist. Unknown name → notice listing valid names.
- `completeArgs` offers preset names.

## Error Handling

- Unknown theme name: notice with valid names, no state change.
- Missing/corrupt `theme.json`: silently fall back to `dark`.

## Testing

- Theme module unit tests: preset lookup, persistence round-trip, corrupt-file fallback.
- Builtins tests (extending `tests/commands.test.ts` patterns): `/compact` and `/init` call
  `sendPrompt` with the right text; `/theme` lists, switches, persists, and rejects unknown names.
