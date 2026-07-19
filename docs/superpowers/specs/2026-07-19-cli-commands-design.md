# CLI Flags, Print Mode, and Subcommands — Design

Date: 2026-07-19
Status: Approved

## Goal

Give the `cloudcode` binary a proper command-line surface: `-h/--help`, short
flags, a non-interactive print mode (`-p`), friendly errors for unknown flags,
and four utility subcommands (`doctor`, `config`, `mcp`, `update`).

## Approach

Stay dependency-free: keep `node:util` `parseArgs` and add a small hand-rolled
dispatcher in `cli.tsx`. Commander/yargs was considered and rejected — the
surface (4 subcommands, ~8 flags) is too small to justify a new runtime
dependency in a project that deliberately has only four.

## Flags

| Flag | Behavior |
|------|----------|
| `-h, --help` | Print usage text, exit 0 |
| `-v, --version` | Print `cloudcode <version>`, exit 0 (existing, gains `-v`) |
| `-c, --continue` | Resume latest session for cwd (existing, gains `-c`) |
| `-r, --resume` | Open resume picker on start (existing, gains `-r`) |
| `--provider <name>` | Select provider (existing; long-only — `-p` is taken) |
| `-p, --print` | One-shot non-interactive mode (see below) |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `bypassPermissions`; print mode only |

Unknown flags: wrap `parseArgs` in try/catch and print a one-line error plus
`Run cloudcode --help for usage.`, exit 1. No Node stack trace.

Argument parsing is extracted into a pure `parseCli(argv)` function returning a
discriminated result (`{ kind: "interactive" | "print" | "subcommand" | "help"
| "version" | "error", ... }`) so it is unit-testable without spawning a
process.

## Print mode

`cloudcode -p "prompt"` — or `echo "prompt" | cloudcode -p` when no positional
prompt is given — runs a single agent turn (including tool loops) without the
interactive UI.

- New module `src/printMode.ts`.
- Reuses `AgentSession` (already UI-independent) with:
  - `onMessage`: stream assistant text deltas to stdout; tool activity is
    summarized to stderr (one line per tool call).
  - `onPermissionRequest`: auto-deny, with a stderr note suggesting
    `--permission-mode acceptEdits` / `bypassPermissions`.
- `--permission-mode` loosens permissions for the run; it is never persisted.
- `--provider` and `-c` (continue latest session) compose with `-p`.
- The session file persists exactly as in interactive mode.
- Exit 0 on a success result, 1 on an error result or thrown failure.

## Subcommands

Dispatched before flag parsing when `argv[2]` exists and does not start with
`-`. Each lives in its own file under `src/commands/cli/`.

### `cloudcode doctor`
Pass/fail checks, exit 1 if any fail:
- Node version ≥ 18
- `~/.cloudcode` exists / is writable
- `providers.json` parses (if present)
- Each configured provider resolves an API key (config `apiKey` or
  `ANTHROPIC_API_KEY` env for anthropic-kind providers)
- `~/.cloudcode/mcp.json` and `./.mcp.json` parse (if present)

### `cloudcode config`
Read-only. Prints config file paths (`settings.json`, `providers.json`,
`mcp.json`) and current effective settings: provider, model, permission mode,
effort, theme, autoMemoryEnabled. `config set` is out of scope for this pass.

### `cloudcode mcp`
Static listing of configured MCP servers from both scopes via existing
`loadMcpServers`, annotating which file each entry came from (user vs
project; project wins on name collision). Does not connect to servers.

### `cloudcode update`
If installed via npm (detected by probing `npm ls -g cloudcode`), run
`npm install -g cloudcode@latest` and stream its output. Otherwise print
install-method-specific update instructions (installer / from-source).

## Help text

Plain template string listing usage, flags, and subcommands. Kept in the same
module as `parseCli` so tests can snapshot it.

## Error handling

- Unknown flag / bad `--permission-mode` value / `-p` with empty stdin and no
  prompt: one-line stderr message + exit 1.
- Subcommand failures (e.g. doctor check errors) report per-item; the process
  exit code reflects overall success.

## Testing

- Vitest units for `parseCli`: every flag, shorts, unknown-flag error,
  subcommand detection, `-p` prompt extraction.
- Help-text snapshot test.
- `doctor` checks against temp dirs (missing/invalid providers.json, etc.).
- Print mode with a fake `MessagesClient` asserting stdout content and exit
  behavior (auto-deny path included).
- `update` and `mcp` logic tested at the pure-function level (formatting,
  npm-detection parsing); no network or real npm in tests.
