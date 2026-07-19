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

## Type discipline

`tsconfig.json` has `"strict": true`; keep it that way. Avoid `any` and
non-null (`!`) assertions — as of this writing `src/` has zero `: any`
annotations and a single `!` assertion. If a cast is unavoidable, prefer
`as unknown as T` with a comment explaining why over a bare `as any`.

## Open gaps (tracked here until closed)

- No `LICENSE` file, despite `package.json` declaring `"license": "MIT"`.

Closed: CI (`.github/workflows/ci.yml`, runs lint/build/test on push and PR
to `master`) and linting (`oxlint`, via `npm run lint`) are both wired up.
`typescript-eslint` was tried first but its peer range caps at TypeScript
`<6.1.0`, which this project's `typescript@^7.0.2` prerelease pin doesn't
satisfy — `oxlint` was used instead since it has no TS-version dependency.
