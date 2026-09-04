# MCP Disable / Enable Design

Date: 2026-09-04
Status: Approved

## Goal

Add `disable` and `enable` operations for MCP servers so users can
temporarily take a server out of use without deleting its config, and
re-enable it later. Works from all three existing MCP surfaces:

- `cloudcode mcp` CLI (static, no connection)
- `/mcp` slash command (runtime session)
- `cloudcode setup` wizard (already supports add/remove)

Disabled servers are persisted in config, excluded from connections,
shown as `disabled` in listings, and take effect on next session
(`/clear` or restart) — same semantics as existing add/remove.

## Non-goals

- Immediate connect/disconnect inside a live session. `/mcp disable`
  only rewrites config and tells the user to `/clear`; no
  `McpManager.disconnect(name)` / reconnect work.
- Disabling pack-contributed servers (`pack__*__*`). Packs are read-only
  contributions, not entries in `.mcp.json` / `mcp.json`, so there is no
  file to flag. Attempting to disable one reports "not found".
- Per-session (memory-only) toggles. State is always written to disk.
- Validation of server names beyond "exists in user/project scope".

## Approaches considered

### A. `disabled: true` flag inside the server config (chosen)

Each entry in `mcpServers` may carry `"disabled": true`. Example:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["gh-mcp"], "disabled": true },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

- Pros: single file, survives add/remove flows, mirrors how the entry is
  already edited; `McpServerConfig` is `Record<string, unknown>` so no
  type migration; unknown keys are preserved by `writeServerFile`.
- Cons: the flag must be stripped before handing the config to
  `McpManager`/SDK, and a foreign tool reading `.mcp.json` sees an extra
  key (Claude Code ignores unknown keys).

### B. Top-level `disabledMcpServers: string[]` per file

- Pros: server configs stay clean.
- Cons: two parallel structures to keep in sync (rename/remove must touch
  both); merge precedence (project overrides user) needs duplicating for
  the disabled list; more code for the same outcome. Rejected.

### C. Disabled list in `settings.json`

- Pros: one central place.
- Cons: splits MCP state across files, breaks `.mcp.json` portability
  (shareable project file no longer tells the full story), and leaks MCP
  detail into the settings owner. Rejected.

## Storage

- `McpServerConfig` stays `Record<string, unknown>`; `disabled === true`
  means disabled. Any other value (missing, false, non-boolean) means
  enabled, so old files keep working.
- `writeServerFile` already preserves unknown top-level keys; setting the
  flag is a read-modify-write of the single named entry, same as
  `saveMcpServer`/`removeMcpServer`. Other keys of that server
  (`command`, `args`, `url`, ...) are left untouched.

## Loader semantics — `src/agent/mcp.ts`

- Add `isMcpServerDisabled(config): boolean` (`config.disabled === true`)
  and `setMcpServerDisabled(name, disabled, scope, cwd, userPath): void`.
  The setter throws / returns "not found" when the name is absent from the
  target file, so callers can report it.
- Scope resolution (shared by CLI, `/mcp`, setup): project wins. If the
  name exists in project scope, operate on the project file; else if it
  exists only in user scope, operate on the user file; else "not found".
  An explicit scope override (`--scope user|project` on CLI) is optional,
  not required.
- `loadMcpServers` (the connect path used by `nativeApp.ts` and
  `printMode.ts`) filters disabled servers out of the merged result, after
  the existing user+project merge and before pack-collision checks. The
  `disabled` key never reaches `McpManager.connect`.
- `loadMcpServersByScope` keeps returning raw entries (including disabled
  ones); presentation layers decide how to render them.
- Effective-disabled rule: the merged (project-overrides-user) entry
  decides. A disabled project entry disables the name even if the user
  entry is enabled, and vice versa.

## Components

### 1. Core helpers — `src/agent/mcp.ts`

```ts
isMcpServerDisabled(config: McpServerConfig): boolean
setMcpServerDisabled(name, disabled, scope, cwd, userPath?): void
resolveMcpServerScope(name, cwd, userPath?): "user" | "project" | undefined
```

No new file formats, no migration.

### 2. CLI — `cloudcode mcp` (`src/cli.tsx`, `src/commands/cli/mcpList.ts`, `src/cliArgs.ts`)

- `cloudcode mcp` (no args): list as today, plus a `disabled` marker:
  `github  [project, disabled]`. Bare listing never connects.
- `cloudcode mcp disable <name> [--scope user|project]` and
  `cloudcode mcp enable <name> [--scope user|project]`: resolve scope
  (explicit flag wins, else project-first), flip the flag, print
  `Disabled github (project). Restart or /clear to take effect.` (same for
  enabled). Missing name: `No MCP server named "<name>".`
- Already-in-state is idempotent with a note (`already disabled`).
- `HELP_TEXT` and subcommand arg parsing updated; only
  `--scope <mode>`-style flag supported, other args rejected as today.

### 3. Slash command — `/mcp` (`src/commands/builtins.ts`, `src/commands/types.ts`, `src/ui/nativeApp.ts`)

- `/mcp` (no args): unchanged status view, except disabled servers render
  as `github  disabled` (no `pending`/`failed` lookup, no tools listed).
- `/mcp disable <name>` / `/mcp enable <name>`: same scope resolution and
  file write as CLI, then `Disabled github (project). Use /clear to reconnect.`
  `CommandContext` gains `mcpSetEnabled(name, enabled): Promise<string>`
  (implemented in `nativeApp.ts` next to existing `mcpStatus`) so the
  command body stays thin per the per-command error boundary rule; bad
  usage prints `Usage: /mcp [disable|enable <name>]`.
- `completeArgs` suggests `disable`/`enable` plus known server names.

### 4. Setup wizard — `src/commands/cli/setup.ts`

`configureMcp` prompt grows from `add/remove/done` to
`add/remove/disable/enable/done`, reusing the same numbered-list picker
and project-first scope as `remove`. Output reuses the
`Disabled <name> (<scope>).` wording.

## Listing and status rendering

- `formatMcpList(scopes)`: appends `, disabled` to the scope tag when the
  effective entry is disabled.
- `formatMcpStatus(configured, statuses, tools, disabled: Set<string>)`: disabled names
  render `name  disabled` regardless of connection state. Enabled servers
  keep current `connected/failed/pending + tools` rendering.

## Error handling

- Follows existing boundaries: config read/parse errors contribute no
  servers (unchanged); tool/command failures surface as `tool_result`
  `is_error` (per-tool), `errorResult` (per-turn), or the single
  `cmd.run().catch()` (per-command). No new try/catch in command bodies.
- New user-visible messages only: `No MCP server named "<name>".`,
  `Pack servers cannot be disabled (<name>).`, `already disabled/enabled`,
  plus the `/clear`-to-reconnect hint. Pack-collision throw in
  `loadMcpServers` is unchanged (disabled entries still participate in
  name resolution before filtering, so a disabled project entry shadowing
  a pack name keeps today's collision error).

## Testing

- `tests/mcp.test.ts`: disabled flag filtering (project/user/both),
  `setMcpServerDisabled` preserves sibling keys and unknown top-level
  keys, `isMcpServerDisabled` false for missing/false/non-boolean,
  `formatMcpStatus` renders `disabled`, scope resolver project-first.
- `tests/mcpList.test.ts`: `formatMcpList` shows the disabled marker.
- `tests/commands.test.ts`: `/mcp disable/enable` writes the flag and
  prints the hint; bad usage prints usage; completion suggests
  subcommands/names.
- CLI tests (extend `cliArgs`/`mcp` coverage): `disable/enable` arg parse,
  `--scope` override, not-found message, idempotent message.
- `tests/cliSetup.test.ts`: wizard disable/enable path via scripted
  prompts.
