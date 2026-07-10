# MCP Server Support Design

Date: 2026-07-10
Status: Approved

## Goal

Let cloudcode use MCP (Model Context Protocol) servers: load server definitions
from config files, pass them to the Claude Agent SDK session, and provide an
`/mcp` command showing server status and available tools.

## Non-goals

- Managing MCP connections ourselves (the Agent SDK owns connections,
  lifecycle, and tool routing).
- `/mcp add/remove/enable/disable` — config changes happen by editing JSON
  files; a new session (`/clear`) picks them up.
- Reading Claude Code's `~/.claude.json` server definitions.
- Config validation beyond basic shape checks — the SDK reports per-server
  connection failures.

## Config sources

Two files, both using Claude Code's `.mcp.json` shape:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "docs":   { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

- **Project:** `<cwd>/.mcp.json` — shareable, checked into the repo.
- **User:** `~/.cloudcode/mcp.json` — personal servers across projects.

Merge: user entries first, project entries override on name conflict.
Missing or malformed files contribute nothing (same tolerance as
`loadProviders`). Server entries are passed through to the SDK unmodified, so
every transport the SDK supports (stdio, http, sse) works.

## Components

### 1. Config loader — `src/agent/mcp.ts`

```ts
loadMcpServers(cwd: string, userPath?: string): Record<string, McpServerConfig>
```

- `userPath` defaults to `join(configDir(), "mcp.json")` (reuses
  `configDir()` from `providers.ts`).
- Reads each file, takes its `mcpServers` object if present and object-typed,
  else `{}`.
- Returns `{ ...user, ...project }`.

### 2. Session wiring — `src/agent/session.ts`, `src/ui/App.tsx`

- `AgentSessionOptions` gains `mcpServers?: Record<string, McpServerConfig>`,
  passed straight into the `query()` options.
- `AgentSession` gains `async mcpStatus()` wrapping `this.q?.mcpServerStatus()`
  (returns the SDK's per-server status list; `[]` when no query is active).
- App calls `loadMcpServers(props.cwd)` whenever it constructs a session
  (startup, `/clear`, provider switch, resume), so editing config + `/clear`
  reconnects with the new server set.

### 3. `/mcp` command — `src/commands/builtins.ts`

- `CommandContext` gains `mcpStatus(): Promise<string>` implemented in App;
  the command prints its result via `ctx.notice`.
- Output: one line per server — name, status (connected/failed/pending as
  reported by the SDK), and tool names when connected. Example:

```
github  connected  tools: create_issue, get_repo
docs    failed
```

- No configured servers: "No MCP servers configured. Add them to .mcp.json
  or ~/.cloudcode/mcp.json."
- `/mcp` takes no arguments; it appears in the autocomplete menu via the
  existing registry.

## Error handling

- A server that fails to connect never blocks startup; it shows as `failed`
  in `/mcp` output.
- Config read/parse errors are silently tolerated (consistent with
  `loadProviders`); the file simply contributes no servers.
- `/mcp` before the session has produced a query, or if `mcpServerStatus()`
  throws, reports "MCP status unavailable." rather than crashing.

## Testing

- `tests/mcp.test.ts` — `loadMcpServers`: project-only, user-only, merge
  precedence (project wins), missing files, malformed JSON, wrong-shape
  `mcpServers` value.
- `tests/session.test.ts` — `mcpServers` option reaches the `queryFn`
  options (existing fake-query pattern).
- `tests/commands.test.ts` — `/mcp` prints the formatted status; the
  no-servers and unavailable cases.
