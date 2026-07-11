# Native Agent Engine: Direct Messages API

Date: 2026-07-11
Status: Approved

## Goal

Replace `@anthropic-ai/claude-agent-sdk` with cloudcode's own agent engine built
on the plain Anthropic Messages API. Today the SDK spawns a bundled ~248 MB
Claude Code native binary (`claude.exe`) as a subprocess; the compiled portable
exe must embed it and extract it to `~/.cloudcode/bin/` at runtime. After this
rewrite, cloudcode is a single self-contained process (~30-50 MB compiled), with
its own agent loop, tools, and permission engine, talking directly to
`/v1/messages` on Anthropic or any compatible endpoint (e.g. local llama.cpp).

## Decisions

- **Full replacement.** The agent SDK dependency is deleted; there is one engine
  and one code path. The embedded-binary build (commit 4b628fd) remains in git
  history as a fallback.
- **Feature scope:** core tools + permissions, session persistence/resume,
  skills, and MCP servers are all kept. Subagents and web search/fetch tools are
  out of scope.
- **Auth:** `ANTHROPIC_API_KEY` plus per-provider `baseUrl`/`apiKey` from
  `providers.json`. No reuse of Claude Code login credentials.

## Architecture

New module `src/engine/` replaces the SDK. `AgentSession`
(`src/agent/session.ts`) keeps its public surface — `start()`, `send()`,
`interrupt()`, `sessionId`, `tools`, and the `onMessage` / `onPermissionRequest`
/ `onSessionId` callbacks — but internally drives the engine loop instead of the
SDK's `query()`.

We define our own message types mirroring the shapes the TUI already consumes
(partial text deltas, tool_use events, result messages with usage). `App.tsx`,
`transcript.ts`, and rendering change only their type imports.

Dependencies: `@anthropic-ai/sdk` (API client, streaming, retries) and
`@modelcontextprotocol/sdk` (MCP stdio client) replace
`@anthropic-ai/claude-agent-sdk`.

### Components

| Component | Responsibility |
|---|---|
| `engine/loop.ts` | Agent loop: request assembly, streaming, tool dispatch, permission gate, auto-continue until `end_turn` |
| `engine/api.ts` | Anthropic client factory from `ProviderConfig` (baseURL, apiKey) |
| `engine/tools/*.ts` | Read, Write, Edit, Bash, Glob, Grep: JSON schema + executor each |
| `engine/tools/registry.ts` | Merges built-in tools with MCP tools (`mcp__server__tool` namespacing) |
| `engine/mcp.ts` | Connects stdio MCP servers from existing `mcp.ts` config; lists and routes their tools |
| `engine/sessions.ts` | JSONL transcript per session under `~/.cloudcode/sessions/`; resume replays into the message array |
| `engine/systemPrompt.ts` | Base agent prompt + project `CLAUDE.md` + skill descriptions from the existing skills scanner |
| `engine/compact.ts` | `/compact`: API-side summarization replacing message history |

### The loop

1. Assemble request: system prompt (with `cache_control`), tool schemas,
   message history.
2. `client.messages.stream()`; forward text/thinking deltas to the TUI as they
   arrive.
3. On `stop_reason: "tool_use"`: for each tool call, consult the permission
   layer (permission mode + per-directory store + interactive dialog via
   `onPermissionRequest`), then execute or deny; append `tool_result` blocks
   (errors as `is_error: true`).
4. Repeat until `end_turn`.

Esc aborts via `AbortController`. API errors surface as the same error-result
messages the TUI handles today. Prompt caching: `cache_control` markers on the
system prompt and message tail. Cost tracked from usage plus a model pricing
table (omitted for unknown/local models).

### Tools

- **Read / Write / Edit** — file operations with the existing permission
  semantics (acceptEdits auto-allows edits; per-directory allow/deny rules from
  `permissionStore` apply).
- **Bash** — PowerShell on Windows, `sh` elsewhere; configurable timeout;
  output truncation.
- **Glob / Grep** — pure-JS implementations (no external binaries) honoring the
  existing ignore conventions (`node_modules`, `dist`).

### Sessions

Own JSONL format, one file per session id. `SessionIndex`, `--continue`,
`--resume`, and `/resume` keep working unchanged. Old SDK-format sessions are
not resumable (accepted one-time break).

## Error handling

- Tool executor exceptions → `tool_result` with `is_error`, loop continues.
- API/network errors → error result message to the TUI; session stays alive for
  retry.
- MCP server failures → surfaced in `/mcp` status; their tools excluded from
  the registry.

## Testing

- Loop tests against an injectable fake transport (scripted stream events).
- Unit tests per tool executor.
- Session save/replay round-trip tests.
- Permission gating tests (mode x rule matrix reuses existing store tests).

## Phases

1. **Working agent:** loop + api + six tools + permission gate + streaming into
   the TUI. SDK removed.
2. **Continuity:** sessions/resume, skills injection, CLAUDE.md.
3. **Completeness:** MCP, `/compact`, prompt caching, cost tracking.

The app builds and runs at the end of each phase.
