# cloudcode — SDK-Based Claude Code Clone: Design

Date: 2026-07-10
Status: Approved

## Goal

An interactive terminal coding agent ("like real Claude Code") built on the official
`@anthropic-ai/claude-agent-sdk`, with a rich Ink TUI, slash commands, session resume,
runtime permission modes, and switchable LLM providers including local llama.cpp.

## Stack

- TypeScript (ESM), Node >= 18
- `@anthropic-ai/claude-agent-sdk` — agent loop, tools, permissions, session persistence
- Ink 5 + React — terminal UI
- `tsx` for dev, `tsc` for dist builds
- `vitest` + `ink-testing-library` for tests

## Core Architectural Decision

**Persistent streaming session**: one SDK `query()` call per session, fed by an
async-generator input stream. User messages are pushed into the generator; SDK messages
stream out to the UI. This gives natural support for interrupts (Esc), runtime
model/permission changes, and the `canUseTool` permission callback — the same approach
real Claude Code uses.

Rejected alternative: one-shot `query({ resume })` per user message — simpler but slower
(restart per turn) and clumsy for interrupts and permission flow.

## Layers

### 1. Agent layer — `src/agent/`

- `session.ts` — wraps SDK `query()`:
  - `send(text)` — push a user message into the input generator
  - `interrupt()` — abort the current turn
  - `setModel(name)`, `setPermissionMode(mode)` — runtime switches
  - Event stream of SDK messages consumed by the UI
  - `canUseTool` callback: forwards permission requests to the UI, awaits the decision
  - `restart(opts)` — dispose and recreate the query (used by `/clear` and provider switch)
- `providers.ts` — provider registry (see Providers below)
- `sessionIndex.ts` — `~/.cloudcode/sessions.json`: session id → cwd, first message,
  timestamp, provider. Powers `--continue`, `--resume`, `/resume`.

### 2. UI layer — `src/ui/`

- `App.tsx` — top-level state machine: idle / streaming / awaiting-permission
- `MessageList.tsx` — transcript: user messages, assistant markdown rendering, tool-call
  chips ("⏺ Read src/foo.ts"), diff rendering for edits
- `PermissionDialog.tsx` — arrow-key yes / no / always dialog driven by `canUseTool`
- `InputBox.tsx` — bordered prompt, slash-command autocomplete, Esc interrupts
- `StatusBar.tsx` — provider, model, cwd, token/cost from result messages

### 3. Command layer — `src/commands/`

Registry of `{ name, description, run(ctx, args) }` modules:
`/help`, `/clear`, `/model <name>`, `/permissions <mode>`, `/provider <name>`,
`/resume`, `/cost`, `/exit`.

## Providers (Option A — base-URL override)

The SDK honors `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` environment overrides, and
recent llama.cpp `llama-server` builds expose a native Anthropic-compatible
`/v1/messages` endpoint. So providers need **no protocol translation code**:

- `~/.cloudcode/providers.json`:

  ```json
  {
    "anthropic": {},
    "local": {
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "none",
      "model": "qwen2.5-coder-32b"
    }
  }
  ```

- `anthropic` (default): no overrides; uses `ANTHROPIC_API_KEY` or existing Claude Code
  login.
- Switching (`/provider local` or `--provider local`) restarts the session with the
  provider's env overrides and default model.
- Status bar always shows the active provider and model.
- Documented caveat: local models are markedly weaker at agentic tool use than Claude;
  degraded behavior on local providers is a model limitation.
- Future extension point (out of scope for v1): an Anthropic→OpenAI translation adapter
  (approach B) can be added as a provider `type` for servers without Anthropic-compat
  endpoints (older llama.cpp, Ollama, LM Studio).

## Sessions & Resume

- SDK persists transcripts and reports a `session_id`.
- `cloudcode --continue` resumes the most recent session for the cwd.
- `cloudcode --resume` / `/resume` shows an interactive picker from the session index.

## Permission Modes

`default` (interactive dialog), `acceptEdits`, `bypassPermissions` — mapped directly to
SDK permission modes. Switchable via `/permissions <mode>` and Shift+Tab cycling.

## Error Handling

- SDK/stream errors render as red notices in the transcript; the REPL survives.
- Ctrl+C once interrupts the current turn; twice exits cleanly (disposes the query).
- Provider restart failures (e.g., local server down) roll back to the previous provider
  with an error notice.

## Testing

- vitest unit tests: command registry, session index, provider config parsing/env
  mapping.
- Agent layer tested against a mocked SDK message stream.
- UI smoke tests with `ink-testing-library` (render transcript, permission dialog flow).

## Out of Scope (v1)

- MCP server support
- Subagents, hooks, custom system prompts
- OpenAI-compat translation proxy (approach B)
