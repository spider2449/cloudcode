# LSP Support in cloudcode

**Date:** 2026-07-21
**Status:** Approved design, ready for implementation plan

## Goal

Add Language Server Protocol (LSP) support to cloudcode so the agent can (a)
navigate code semantically — go-to-definition, find-references, hover, symbol
search — instead of relying only on grep/read, and (b) receive real
compiler/linter diagnostics after it edits a file, closing a self-correction
loop. Both consumers sit on top of one shared LSP client layer.

## Architecture

A single **LSP client layer** underlies two consumers: the navigation tools and
the post-edit diagnostics hook.

```
                ┌─────────────────────────────────────┐
                │  LspManager (one per session/cwd)    │
                │  - registry: lang → server config     │
                │  - pool: (lang, root) → warm LspServer│
                │  - detect(file) → lang | null         │
                │  - diagnostics cache: uri → Diag[]    │
                └───────────────┬──────────────────────┘
                                │
          ┌─────────────────────┼──────────────────────┐
          │                     │                        │
   Navigation tools      Diagnostics tool          Auto-inject hook
   (Definition,          (pull, on-demand)         (in runTool, after
    References,                                      Edit/Write success)
    Hover, Symbols)
```

- **`LspServer`** wraps one language-server child process: JSON-RPC over stdio,
  `initialize` handshake, `textDocument/didOpen` + `didChange` sync, request
  methods (`definition`, `references`, `hover`, `documentSymbol`,
  `workspaceSymbol`), and `publishDiagnostics` capture.
- **`LspManager`** owns the registry (defaults + config override), lazy-spawns
  and pools one `LspServer` per (detected language, workspace root), and is
  created once per session. Threaded into `ToolContext` so every tool shares the
  same warm pool. Cleanly shuts down all servers on session exit.
- **Diagnostics** arrive asynchronously via `textDocument/publishDiagnostics`
  notifications; `LspManager` caches the latest set per file URI so both the pull
  tool and the auto-inject hook read from the same cache.

### Integration points

- `ToolContext` (`src/engine/tools/types.ts`) gains an `lsp?: LspManager` field.
- `builtinTools()` (`src/engine/registry.ts`) gains the new tools.
- `runTool` (`src/engine/loop.ts:279`) post-processes `Edit`/`Write` results to
  append diagnostics.
- The `LspManager` is constructed once per session and passed into the tool
  context alongside `cwd`/`signal`.

Proposed module layout under `src/engine/lsp/`:
- `defaults.ts` — built-in server table
- `config.ts` — load + merge `lsp.json` over defaults
- `detect.ts` — extension → language, root-marker walk-up
- `rpc.ts` — JSON-RPC framing (Content-Length) encode/decode
- `server.ts` — `LspServer` process wrapper
- `manager.ts` — `LspManager` pool + diagnostics cache
- `format.ts` — output formatting for tools and the diagnostics block

## Registry, config, and detection

### Built-in defaults table

| Language | Extensions | Command | Root markers |
|---|---|---|---|
| typescript | `.ts .tsx .js .jsx .mjs .cjs` | `typescript-language-server --stdio` | `tsconfig.json`, `package.json`, `.git` |
| python | `.py .pyi` | `pyright-langserver --stdio` | `pyproject.toml`, `setup.py`, `.git` |
| rust | `.rs` | `rust-analyzer` | `Cargo.toml`, `.git` |
| go | `.go` | `gopls` | `go.mod`, `.git` |

### Config override

`~/.cloudcode/lsp.json` (user) and optional project-local `.cloudcode/lsp.json`,
same shape as a defaults entry. Keys merge over defaults by language name; a user
can add a new language, change the command, or disable one with
`"enabled": false`. Mirrors how `providers.json` already works.

```json
{
  "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
  "elixir": { "extensions": [".ex", ".exs"], "command": "elixir-ls", "rootMarkers": ["mix.exs"] }
}
```

Precedence: project-local `lsp.json` over user `lsp.json` over built-in defaults.

### Detection & availability

- `detect(filePath)` → language by extension match.
- A server is only spawnable if its command resolves on `PATH` (checked once,
  cached). If a file's language has no installed server, LSP features silently
  no-op for it — no errors surfaced to the model.
- `cloudcode doctor` gains a section listing detected languages and whether each
  server was found on `PATH`.
- **Workspace root:** walk up from the file to the nearest root marker; fall back
  to `cwd`. One server instance per (language, workspace-root) pair.

## LspServer process & protocol lifecycle

Each `LspServer` wraps one child process and speaks LSP over stdio.

### Startup (lazy, on first use for a language)

1. Spawn the command; frame JSON-RPC messages with `Content-Length` headers over
   stdin/stdout.
2. Send `initialize` with our capabilities + workspace root, await result, send
   `initialized`.
3. Mark ready. Concurrent callers awaiting the same server share one init promise
   (no double-spawn).

### Document sync

LSP requires the server to know file contents. Before any request touching a
file, `ensureOpen(uri)` sends `textDocument/didOpen` (reading current disk
contents). After an `Edit`/`Write`, the diagnostics hook sends
`textDocument/didChange` with the new full text (full-sync mode — simplest,
correct) so the server re-analyzes. Track open URIs + version numbers.

### Requests

Thin async methods — `definition`, `references`, `hover`, `documentSymbol`,
`workspaceSymbol` — each a JSON-RPC request/response keyed by an incrementing id,
resolved via a pending-requests map. All honor the `AbortSignal` (reject + drop
on abort).

### Diagnostics

The server pushes `textDocument/publishDiagnostics` notifications unsolicited. We
store the latest array per URI in the manager's cache. Since they're async, the
auto-inject hook waits a short bounded window (up to ~1.5s, resolving early once
a fresh publish for that URI arrives after the `didChange`) so it captures the
re-analysis without hanging the turn.

### Robustness

- A server that crashes or fails to spawn is marked dead; its language no-ops for
  the rest of the session (logged once). Errors never propagate into tool results
  as failures.
- On session exit, send `shutdown`/`exit` and kill after a timeout.

## Tools, auto-inject hook, and output format

### New agent-facing tools (registered in `builtinTools()`)

- **`Definition`** — input `{ file, line, column }` (1-based, converted to LSP
  0-based internally). Returns the defining location(s) as `file:line:col` plus a
  snippet line.
- **`References`** — `{ file, line, column, includeDeclaration? }`. Returns a
  capped list (100) of `file:line:col` locations with the matching line text.
- **`Hover`** — `{ file, line, column }`. Returns the server's hover markdown
  (type signature / doc), stripped to plain text.
- **`Symbols`** — `{ file }` for document symbols, or `{ query }` for workspace
  symbols. Returns name, kind, and location.
- **`Diagnostics`** — `{ file? }`. With `file`, returns cached diagnostics for it
  (opening/refreshing as needed); without, returns diagnostics across all
  currently-open files. This is the pull half.

All tools resolve relative paths against `cwd`, no-op gracefully (return a short
"no LSP server for `.xyz`" note, not an error) when unavailable, and share the
warm pool via `ctx.lsp`.

### Auto-inject hook (in `runTool`, loop.ts)

After a successful `Edit`/`Write`, if the edited file's language has a live
server, send `didChange`, await the bounded diagnostics window, and if any
errors/warnings exist for that file, append a concise capped block to the tool
result:

```
--- diagnostics (edited file) ---
foo.ts:12:5 error TS2345: Argument of type 'string' is not assignable to 'number'.
foo.ts:20:1 warning: 'x' is declared but never used.
(2 issues)
```

Capped (first ~10, errors before warnings). Only the edited file — never a
project-wide dump. Injects nothing when the file is clean.

### Permissions

All five tools are read-only queries, so they default to allow (no prompt), like
Read/Grep. The auto-inject hook piggybacks on the already-permitted Edit/Write.

## Testing strategy

The project uses **vitest** (`npm run test`). LSP is I/O- and subprocess-heavy,
so the plan isolates pure logic from real servers.

### Unit (no real servers)

- JSON-RPC framing — encode/decode `Content-Length` messages, partial-buffer
  reassembly, multiple messages in one chunk.
- Registry merge — defaults + user config override, `enabled: false`, adding a
  new language, project-over-user precedence.
- Detection — extension → language; root-marker walk-up; `cwd` fallback.
- Position conversion — 1-based tool input ↔ 0-based LSP.
- Diagnostics cache & bounded-wait window (early-resolve on publish, timeout
  path) — driven by a fake in-memory server over piped streams.
- Output formatting — location lists, hover stripping, diagnostics block
  capping/ordering.

### Fake language server

A small scripted stdio responder used across manager/tool tests: canned
`initialize`, definition/references/hover responses, and scripted
`publishDiagnostics`. Exercises the full manager→server→tool path
deterministically and fast.

### Optional integration (guarded)

One smoke test against a real `typescript-language-server` if present on `PATH`,
skipped otherwise (`it.skipIf`). Not required for CI.

### Order (TDD)

Framing and registry first, then manager lifecycle against the fake server, then
each tool, then the auto-inject hook.
