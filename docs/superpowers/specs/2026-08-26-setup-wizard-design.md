# `cloudcode setup` — interactive configuration wizard

Date: 2026-08-26
Status: approved design, pending implementation plan

## Problem

`cloudcode -h` offers only read-only introspection (`config`, `mcp`, `doctor`).
Every writable setting — MCP servers, file-permission rules, provider/model,
network mode, theme — must be configured by hand-editing JSON files. Users have
no discoverable CLI surface for setting anything.

## Goal

A new `setup` subcommand: an interactive, readline-based wizard that walks the
user through the full configuration surface and writes each section as it is
completed. `-h` gains one line advertising it.

## Non-goals

- No per-section subcommands (`setup mcp`, ...) — the wizard is the single entry point.
- No TUI/arrow-key pickers; setup runs outside a session with plain prompts.
- No new settings beyond what config owners already support.

## UX contract

- Sequential numbered prompts via `readline`, same pattern as `cloudcode login`.
- Every section prints current effective values first; pressing Enter keeps them.
- Sections run in order: provider/model → network mode → MCP servers →
  permission rules → appearance/misc → summary.
- Save-as-you-go: each section persists when completed; Ctrl+C aborts the
  wizard but keeps already-saved sections.
- Invalid input re-prompts instead of exiting.

### Section details

1. **Provider/model** — list keys from `loadProviders()`; user picks a number
   or types a name → `saveSetting("provider", name)`. Optional model prompt;
   Enter keeps the current model (no write) → otherwise `saveSetting("model",
   value)`.
2. **Network mode** — choose one of `offlineStrict | providerOnly |
   unrestricted` → `saveSetting("networkMode", mode)`.
3. **MCP servers** — loop menu `[a]dd / [r]emove / [d]one`.
   - Add: name, transport (`stdio` | `http`), then command + args (stdio) or
     URL (http), then scope (`user` = `~/.cloudcode/mcp.json`, `project` =
     `.mcp.json`).
   - Remove: list existing names with scope, pick one to delete.
   - Writes go through new helpers in `agent/mcp.ts`: `saveMcpServer(name,
     config, scope)` and `removeMcpServer(name, scope)`, both read-modify-write
     preserving unknown top-level JSON keys (same convention as
     `loadRaw`/`saveSetting` in `agent/settings.ts`). stdio servers are stored
     as `{ command, args }`; http servers as `{ url }`.
4. **Permission rules** — show current rules from `PermissionStore.list()`,
   then loop `[a]llow / [d]eny / [r]emove / [d]one`. Allow/deny asks the rule
   kind (directory path / Bash command prefix / WebFetch host) and routes to
   `rememberDir`, `rememberCommand`, or `rememberHost`; remove deletes a rule
   by index and re-persists via `clear()`-style rewrite (new small
   `removeAt(index)` method on `PermissionStore`). Rules stay project-scoped
   (`.cloudcode/permissions.json`).
5. **Appearance/misc** — theme (free string, empty keeps), effort level (valid
   values re-prompted), `autoMemoryEnabled` y/n.
6. **Summary** — print resulting effective values by reusing `configReport`.

## Architecture

- `src/commands/cli/setup.ts` — wizard orchestration and prompts only; calls
  into existing config owners (`agent/settings.ts`, `agent/mcp.ts`,
  `agent/permissionStore.ts`, `agent/providers.ts`). No UI/renderer imports,
  no direct JSON writes outside those owners.
- `src/cliArgs.ts` — add `"setup"` to `SUBCOMMANDS`; add the help line:
  `setup    Interactive walkthrough of providers, MCP servers, permissions, and settings`.
- `src/cli.tsx` — dispatch case calling `runSetupCommand(args, deps)` with an
  injectable-deps object mirroring `LoginDeps` (`promptText?`,
  `configBase?`, `cwd?`).

## Error handling

- Input validation happens inline in the wizard loop (re-prompt on invalid).
- File write failures abort the current section with an error line; earlier
  sections stay saved. No new global try/catch — follows the project's
  boundary rules (per-command catch covers the rest).

## Testing

`tests/cli-setup.test.ts` mirrors the login tests: inject `promptText` to
script answers, point `configBase`/`cwd` at temp directories, then assert the
resulting JSON files:

- MCP add/remove in both scopes, including preservation of unknown top-level keys.
- Permission rules routed to dir/prefix/host storage; remove-by-index.
- Settings saves for provider, model, network mode, theme, effort, autoMemory.
- Enter-keeps-current behavior for every section.
