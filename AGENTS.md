# AGENTS.md

Architecture and contribution rules for cloudcode. This file exists so
placement and size decisions don't have to be re-derived (or drift) as the
project grows. Written 2026-07-19; revisit as the codebase matures.

## Where things go

- **`src/engine/`** — provider-facing agent logic: the turn loop
  (`loop.ts`), tool implementations (`tools/`), compaction, permission
  decisions, pricing, system prompt assembly. Code here should not know
  about the terminal UI or about session/settings file formats. If a module
  needs `fs` access for anything beyond a tool's own read/write/edit
  semantics, it probably belongs in `agent/` instead.
- **`src/agent/`** — persistence and configuration: sessions, session
  index, settings, permission store, provider config, MCP client wiring,
  skills. This is the "what does the user's machine/project look like"
  layer. Code here should not know about rendering.
- **`src/commands/`** — the user-facing command surface: slash commands
  (`builtins.ts`, `registry.ts`) and `cloudcode <subcommand>` CLI entries
  (`cli/`). Commands orchestrate `engine`/`agent` calls; they don't
  implement engine or persistence logic themselves.
- **`src/ui/`** — the hand-rolled terminal renderer: ANSI/terminal
  primitives (`term/`), widgets, themes, layout, markdown rendering. No
  provider/network calls belong here.

When a change could plausibly live in two places, prefer the layer closer
to what the code *is* (a tool → `engine/tools/`, a new config field → the
existing owner of that config file) over where it's *used from*.

## Provider abstraction pattern

`src/engine/api.ts` (Anthropic-native) and `src/engine/openaiApi.ts`
(OpenAI-compatible: local llama.cpp, NVIDIA NIM, etc.) both implement the
same request-shape contract consumed by `loop.ts`. A new provider should
add a third file following that same contract rather than branching inside
`loop.ts` — the loop must stay provider-agnostic.

## Module size

No file in `src/` should grow past **~600 lines** without a deliberate
decision to split it, and past **~1,000 lines** without actually splitting
it. This is a guideline, not yet a mechanized check (see Open gaps below).
`src/ui/nativeApp.ts` (currently ~670 lines) is the file most likely to hit
this first — when it does, split along the seams already implicit in
`ui/`: input handling, render orchestration, and overlay/menu wiring should
become separate modules rather than growing in place.

## Testing convention

Every module in `src/` gets a corresponding file in `tests/` (the existing
near-1:1 mapping should be preserved — see `tests/engine-*.test.ts`,
`tests/cli*.test.ts`, etc.). Tests land in the same commit as the feature,
not as follow-up cleanup. Keep test files under the same size guidance as
production code — don't let `tests/` accumulate a monolithic file per
subsystem.

## Error handling: catch at the boundary, not at every call site

Errors are handled at three deliberate boundaries — new code should rely on
these rather than adding its own try/catch:

1. **Per-tool** (`engine/loop.ts`, `runTool`): a thrown tool error becomes a
   `tool_result` with `is_error: true` fed back to the model. The turn
   continues.
2. **Per-turn** (`engine/loop.ts`, `send`): any error during the API
   call/stream (network failure, malformed SSE) becomes an `errorResult`
   message shown to the user. The session survives.
3. **Per-command** (`ui/nativeApp.ts`, the single `cmd.run(...).catch(...)`
   at slash-command dispatch): covers every command uniformly, so
   individual command bodies (see `commands/builtins.ts`) don't need their
   own try/catch just to avoid crashing the app.

Below all three, `cli.tsx`'s `uncaughtException` handler logs a stack trace
to the terminal and **intentionally rethrows to crash** — that's correct
for a stateful TUI process; don't add a handler that swallows and
continues instead.

Config/session file loaders (`agent/sessionIndex.ts`, `agent/settings.ts`,
`agent/mcp.ts`, `agent/providers.ts`) each wrap their own
`readFileSync`+`JSON.parse` and fall back to defaults on any error — keep
that pattern for any new on-disk config file rather than relying on the
boundaries above, since those run before a session/turn/command exists.

## Type discipline

`tsconfig.json` has `"strict": true`; keep it that way. Avoid `any` and
non-null (`!`) assertions — as of this writing `src/` has zero `: any`
annotations and a single `!` assertion. If a cast is unavoidable, prefer
`as unknown as T` with a comment explaining why over a bare `as any`.

## Dependency version policy

`typescript@^7.0.2` and `@types/node@^26.1.1` are deliberate early adoption
of the Go-ported `tsc` and current Node types, not an oversight — keep
using `^` ranges for these rather than tightening to `~`. The tradeoff this
creates: `typescript-eslint`'s peer range caps at TypeScript `<6.1.0`, so it
can't be used here; `oxlint` is used instead (no TS-version dependency).
Re-evaluate `typescript-eslint` once it supports TS 7.

## Open gaps (tracked here until closed)

None currently tracked. See "Closed" below for what's been addressed.

Closed: CI (`.github/workflows/ci.yml`, runs lint/build/test/audit on push
and PR to `master`), linting (`oxlint`, via `npm run lint`), dependency
auditing (`npm audit --audit-level=high` in CI plus `.github/dependabot.yml`
for weekly npm/Actions update PRs), the missing `LICENSE` file, and a
release smoke test (`.github/workflows/release-smoke-test.yml`, triggered
on `v*` tags: builds the npm package and the Windows/Linux compiled
binaries, then runs each with `--version` to catch a broken packaging
script before users hit it). Note: that workflow calls
`scripts/build-binaries.sh` directly on Linux rather than
`npm run package:bin`, because that npm script shells out to Windows
PowerShell specifically — `build-binaries.sh` covers Linux/macOS but isn't
wired to any npm script; the smoke test doesn't cover macOS or the Inno
Setup installer (`installer/cloudcode.iss`, Windows-only, needs ISCC on the
runner) yet.
