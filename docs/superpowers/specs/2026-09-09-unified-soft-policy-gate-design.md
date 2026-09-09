# Design: Unified Soft Policy Gate (Option A)

Date: 2026-09-09
Status: Approved (§1 + §2 revised)

## Problem

File/search tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) enforce cwd
confinement in `decidePermission` (`src/engine/permissions.ts`), but the
checks are spread across three helpers (`isInsideCwd`, `isMemoryLocation`,
`matchNetworkStorage`), and `Bash` has no path confinement at all: it runs
with `cwd` set (`src/engine/tools/bash.ts`) yet any command string can
`cd ..` or name absolute paths. The hard sandbox (`src/agent/sandbox.ts`)
is Linux-only (`win32` returns unavailable), so Windows has no OS-level
backstop.

## Goals

- Single policy gate: one `classify(path)` owns path qualification for all
  tools, including `Bash` via lightweight path extraction.
- Unified management with an explicit allowlist: `cwd` + `~/.cloudcode`
  (minus sensitive credential files) + `networkStorage` allow rules.
- Permission settings are the sole allow authority: paths under the project
  with an `allow` rule are honored; outside paths with no rule always ask.
- Cross-platform: pure Node path logic, no new OS dependency.

## Non-goals

- Hard OS isolation (Windows Job Object / AppContainer, macOS Seatbelt).
- Full shell parsing for `Bash` (only common absolute-path / `cd` /
  redirection / `Get-Content`+`cat` shapes).
- Changes to `~/.cloudcode` ownership semantics (already defined).

## Architecture (§1, approved)

No new file. Extend `src/engine/permissions.ts` (201 lines, under the
600-line ceiling):

- New `classify(path, cwd, networkStorage)` returns one of `inside` |
  `owned` | `networkAllow` | `sensitive` | `outside`, merging the current
  `isInsideCwd` / `isMemoryLocation` / `matchNetworkStorage` logic.
  `owned` = everything under `configDir()` except `credentials.json` and
  `providers.json`; `sensitive` = those two files.
- `decidePermission` keeps its flow; the `outsideCwdFile` / `outsideCwdSearch`
  predicates call `classify` instead of inline ternaries.
- `Bash` gains a lightweight extractor (absolute paths `C:\`, `\\server\`,
  `/...`, `~/`; `cd` targets; `>` / `>>` targets; `Get-Content` / `cat`
  arguments). Each extracted path goes through `classify`; any `outside` or
  `sensitive` result forces the call to `ask` unless a matching `allow` rule
  covers that directory (per the store-first rule below).

## Data flow / errors / tests (§2 revised, approved)

- Flow: tool input -> `ruleScope` / `hostScope` (-> `Bash` extractor) ->
  `classify` -> `store.check` (deny beats allow) -> mode defaults.
- `store.check` is the sole allow authority: `deny` always wins; `allow`
  (project `.cloudcode/permissions.json` dir rules, global `settings.json`
  `networkStorage` rules) is the only way an `outside` path is permitted.
  Inside/owned/networkAllow paths still consult the store first; unmatched
  outside paths always ask, including under `bypassPermissions`.
- Error handling: unchanged three boundaries (per-tool `tool_result`
  `is_error`, per-turn `errorResult`, per-command catch). No new try/catch;
  config loaders keep read+parse fallback-to-default.
- Tests (in `tests/engine-permissions.test.ts`): inside allows; outside
  `Read` / `Write` / `Grep` ask even under `bypassPermissions`; owned allows;
  sensitive still asks; `Bash` naming `C:\Windows\...` asks; matching `allow`
  rule permits an outside dir; matching `deny` blocks `bypassPermissions`.

## Cross-OS note

Soft gate is portable by construction (`resolve` + `sep`, win32-only case
folding, same convention as `normalizePath`). Hard sandbox stays as-is
(Linux `unshare` / `bwrap`, `win32` unavailable).
