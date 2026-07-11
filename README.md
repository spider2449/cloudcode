# cloudcode

A Claude Code-style terminal coding agent built on the Claude Agent SDK, with an Ink
TUI, slash commands, session resume, permission modes, and switchable providers
including local llama.cpp.

## Setup

    npm install
    npm run dev

Auth: set `ANTHROPIC_API_KEY`, or rely on an existing Claude Code login.

## Local models (llama.cpp)

Requires a recent llama.cpp build whose `llama-server` exposes the
Anthropic-compatible `/v1/messages` endpoint. Create `~/.cloudcode/providers.json`:

    {
      "local": {
        "baseUrl": "http://127.0.0.1:8080",
        "apiKey": "none",
        "model": "qwen2.5-coder-32b"
      }
    }

Then `npm run dev -- --provider local` or `/provider local` at runtime.

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

## Commands

/help /clear /compact /config /init /model /permissions /provider /resume /set
/cost /mcp /skills /skill /theme /exit
Shift+Tab cycles permission modes. Esc interrupts. Ctrl+C twice exits.

## UX

Streaming output renders token by token; assistant replies render as markdown with
syntax-highlighted code blocks; Edit/Write tools show a colored diff preview.
Input supports cursor movement (←/→), command history (↑/↓, persisted to
~/.cloudcode/history.json), and multi-line input (end a line with \ and press Enter).

## Release

    npm run package         # npm tarball + binaries + Windows installer
    npm run package:npm     # build + `npm pack` into release/
    npm run package:bin     # bun-compiled standalone binaries into release/
                             #   (win-x64, macos-arm64, macos-x64, linux-x64)
    npm run package:installer  # Windows installer via Inno Setup (installer/cloudcode.iss)

`package:bin` requires `bun` on PATH (or `~/.bun/bin/bun.exe`); `package:installer`
requires Inno Setup 6 (ISCC.exe) and is Windows-only. All outputs land in `release/`.

## Permission memory

In the permission dialog for file tools (Read/Write/Edit), choose
"Always for this directory" or "Never for this directory" to remember the decision
for the file's directory and all subdirectories. Rules are stored per project in
`.cloudcode/permissions.json` (add `.cloudcode/` to your `.gitignore` if you don't
want them version-controlled). Deny rules beat allow rules. Manage them with
`/permissions list` and `/permissions clear`.
