# cloudcode

A Claude Code-style terminal coding agent with its own native agent engine (no
subprocess, no bundled CLI) talking directly to the Anthropic Messages API, with
a hand-rolled alt-screen TUI, slash commands, session resume, permission modes,
and switchable providers including local llama.cpp and OpenAI-compatible
endpoints such as NVIDIA NIM.

## Setup

    npm install
    npm run dev

Auth: set `ANTHROPIC_API_KEY`. Reusing an existing Claude Code CLI login is not
supported — cloudcode talks to `/v1/messages` directly rather than spawning the
Claude Code CLI, so it needs its own API key (or a compatible local endpoint,
see below).

## CLI usage

    cloudcode                 # interactive session
    cloudcode -c              # continue the latest session in this directory
    cloudcode -r              # pick a session to resume
    cloudcode -p "prompt"     # one-shot non-interactive run (or pipe the prompt on stdin)
    cloudcode doctor          # check environment and configuration health
    cloudcode config          # show config paths and effective settings
    cloudcode mcp             # list configured MCP servers
    cloudcode update          # update to the latest version

Print mode auto-denies any tool call that would normally prompt; pass
`--permission-mode acceptEdits` (or `bypassPermissions`) to loosen that for
a single run. Run `cloudcode --help` for the full flag list.

## Local models (llama.cpp)

Requires a recent llama.cpp build whose `llama-server` exposes the
Anthropic-compatible `/v1/messages` endpoint. Create `~/.cloudcode/providers.json`:

    {
      "local": {
        "baseUrl": "http://127.0.0.1:8080",
        "apiKey": "none",
        "model": "qwen2.5-coder-32b",
        "model_context_window": 32768
      }
    }

Then `npm run dev -- --provider local` or `/provider local` at runtime.

`model_context_window` overrides the 200k default used to compute the context
usage percentage shown in the status bar and to trigger auto-compact — set it
to your local model's actual context size (check `n_ctx` from the server's
`/v1/models` response).

Note: local models are markedly weaker at agentic tool use than Claude; degraded
behavior on local providers is a model limitation, not a cloudcode bug.

### llama-server must be launched with a tool-capable chat template

The agent loop only auto-continues after a tool call when the server reports
`stop_reason: "tool_use"` and emits real `tool_use` content blocks. Both depend on
llama-server's chat template supporting tools. Two known failure modes:

- **Agent stops after every tool call and waits for input ("continue").** The
  active template has no tools/tool_call section, so the model's tool calls come
  back as plain text and `stop_reason` is always `end_turn`. This happens with
  `--chat-template chatml` — that flag silences template errors but breaks tool
  calling entirely. Diagnose with `GET /props`: if `chat_template` does not
  mention `tool_call`, tool calling cannot work.
- **HTTP 500 "System message must be at the beginning".** The model's embedded
  template is too strict for agent-style conversations (common with Qwen-derived
  reasoning models such as Ornith).

Both are fixed by launching with a patched agent-friendly template instead:

    llama-server -m <model>.gguf --jinja --chat-template-file chat_template.jinja --reasoning-format deepseek

where `chat_template.jinja` is a tool-capable template matching your model family
(for Qwen-based models: https://huggingface.co/unsloth/Qwen3.5-35B-A3B/raw/main/chat_template.jinja).
`--reasoning-format deepseek` keeps `<think>` blocks out of the visible reply.

Verify the setup by POSTing a tool-forcing request to `/v1/messages`: the response
must contain a `tool_use` content block and `stop_reason: "tool_use"`.

## LSP support

cloudcode can use language servers for semantic navigation and diagnostics. It
ships known configs for TypeScript/JavaScript (`typescript-language-server`),
Python (`pyright-langserver`), Rust (`rust-analyzer`), and Go (`gopls`), and
auto-detects which apply from the files you edit. A server is only used if its
command is on your `PATH` — otherwise LSP features quietly no-op.

The agent gains `Definition`, `References`, `Hover`, `Symbols`, and
`Diagnostics` tools, and diagnostics for a file are appended automatically after
it edits that file.

Override or add servers in `~/.cloudcode/lsp.json` (or project-local
`.cloudcode/lsp.json`):

    {
      "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
      "elixir": { "extensions": [".ex", ".exs"], "command": "elixir-ls", "rootMarkers": ["mix.exs"] }
    }

Disable a built-in with `{ "go": { "enabled": false } }`. Run `cloudcode doctor`
to see which servers were found.

## OpenAI-compatible providers (NVIDIA NIM, etc.)

Providers that speak OpenAI's Chat Completions API (`/chat/completions`) instead
of the Anthropic Messages API — for example NVIDIA NIM — are supported by adding
`"kind": "openai"` to the provider entry in `~/.cloudcode/providers.json`:

    {
      "nim": {
        "kind": "openai",
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiKey": "nvapi-...",
        "model": "z-ai/glm-5.2"
      }
    }

Then `npm run dev -- --provider nim` or `/provider nim` at runtime. Without
`"kind": "openai"`, a `baseUrl` is assumed to be an Anthropic-compatible proxy
(like the local llama.cpp setup above).

## MCP servers

MCP server configs are loaded from two files at startup and merged (project
entries win on name conflicts):

- Project: `<cwd>/.mcp.json` — shareable, can be checked into the repo.
- User: `~/.cloudcode/mcp.json` — personal servers across projects.

Both use Claude Code's `.mcp.json` shape: servers must live under a top-level
`mcpServers` key, and stdio servers use a string `command` plus an `args` array.
Files that are missing, invalid JSON, or missing the `mcpServers` key silently
contribute no servers.

    {
      "mcpServers": {
        "thunderbird": {
          "type": "stdio",
          "command": "node",
          "args": ["D:\\path\\to\\mcp-bridge.cjs"]
        }
      }
    }

Check loaded servers and their tools with `/mcp` at runtime.

## Commands

/help /clear /compact /config /init /model /permissions /provider /resume /set
/cost /mcp /skills /skill /theme /memory /exit
Shift+Tab cycles permission modes. Esc interrupts. Ctrl+C twice exits.

## Memory

Memory is automatically managed and persists between sessions. Use `/memory` to open a picker to edit:
- **User memory** (`~/.cloudcode/CLOUDCODE.md`) — user-level instructions that apply to all projects.
- **Project memory** (`./CLAUDE.md`) — project-specific instructions stored in the project root.
- **Auto-memory folder** (`~/.cloudcode/projects/<sanitized-project-path>/memory/`) — automatically indexed memory organized by topic.

The auto-memory system creates and maintains memory files under `~/.cloudcode/projects/<sanitized-project-path>/memory/`, with an auto-generated `MEMORY.md` index and per-topic memory files. This can be disabled with `/config autoMemory false` (default: `true`).

User-level instructions (`~/.cloudcode/CLOUDCODE.md`) are now loaded at startup in addition to the project-level `./CLAUDE.md`, giving you persistent settings and preferences across all projects.

## Themes

`/theme <name>` switches the color theme (no argument lists all available themes). Built in: `dark`, `light`, `mono`, `dracula`, `catppuccin`, `gruvbox`, `tokyonight`, `nord`, `one-dark`, `solarized`, `rosepine`, `github`, `monokai`. Drop your own theme JSON files into `~/.cloudcode/themes/*.json` — the filename (without `.json`) becomes the theme name, and a custom theme overrides a built-in of the same name.

## UX

The UI is a hand-rolled TUI on the terminal's alternate screen: the transcript
scrolls independently while the input box and status bar stay pinned to the
bottom. Scroll with the mouse wheel or PgUp/PgDn/Home/End; End (or any new
message) returns to stick-to-bottom. Because the app captures the mouse,
select text with Shift+drag.

Streaming output renders token by token; assistant replies render as markdown with
syntax-highlighted code blocks; Edit/Write tools show a colored diff preview.
Input supports cursor movement (←/→), command history (↑/↓, persisted to
~/.cloudcode/history.json), and multi-line input (end a line with \ and press Enter).

## Release

    npm run package         # npm tarball + binaries + Windows installer
    npm run package:npm     # build + `npm pack` into release/
    npm run package:bin     # bun-compiled standalone binary for the host OS into release/
    npm run package:installer  # Windows installer via Inno Setup (installer/cloudcode.iss)

`package:bin` requires `bun` on PATH (or `~/.bun/bin/bun.exe`) and only builds a
binary for the OS it runs on: `cloudcode-win-x64.exe` on Windows, `cloudcode-linux-x64`
elsewhere. `package:installer` requires Inno Setup 6 (ISCC.exe) and is Windows-only.
All outputs land in `release/`.

Building `cloudcode-linux-x64` from Windows: bun's `--target=bun-linux-x64` cross-compile
can fail on Windows with `Failed to extract executable for 'bun-linux-x64-...'` even
though the downloaded tarball is intact — bun's own extractor has a bug here, unrelated
to network/proxy/AV. Build natively in WSL instead (install bun there once with
`curl -fsSL https://bun.sh/install | bash`):

    wsl bun build --compile --target=bun-linux-x64 scripts/bin-entry.ts --outfile release/cloudcode-linux-x64

Each compiled binary is fully self-contained: the agent loop, tools, and
permission engine are cloudcode's own code, so there is no bundled native CLI
and nothing extracted to disk at runtime. Binaries run standalone from any
directory.

Sessions are stored as JSONL under `~/.cloudcode/sessions/`. This is a new
format introduced with the native engine; sessions created before that change
are not resumable.

## Permission memory

In the permission dialog for file tools (Read/Write/Edit), choose
"Always for this directory" or "Never for this directory" to remember the decision
for the file's directory and all subdirectories. Rules are stored per project in
`.cloudcode/permissions.json` (add `.cloudcode/` to your `.gitignore` if you don't
want them version-controlled). Deny rules beat allow rules. Manage them with
`/permissions list` and `/permissions clear`.
