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

## Commands

/help /clear /model /permissions /provider /resume /cost /exit
Shift+Tab cycles permission modes. Esc interrupts. Ctrl+C twice exits.

## UX

Streaming output renders token by token; assistant replies render as markdown with
syntax-highlighted code blocks; Edit/Write tools show a colored diff preview.
Input supports cursor movement (←/→), command history (↑/↓, persisted to
~/.cloudcode/history.json), and multi-line input (end a line with \ and press Enter).
