# cloudcode Codebase Review

Date: 2026-07-21 · Branch: `master` @ `c038a21` (+ working-tree security fixes) ·
Reviewer: Claude Code

> Supersedes the 2026-07-19 review at `a5e0cf5`. That review's recommendations
> have since been closed (see §2); this pass adds two code-level security
> findings and their fixes.

## 1. Overview

cloudcode is a terminal AI coding agent: a from-scratch reimplementation of a
Claude-Code-style CLI with its own agent engine (no subprocess, no bundled
vendor CLI) talking directly to the Anthropic Messages API, plus an
OpenAI-compatible path for local/alternate providers (llama.cpp, NVIDIA NIM).
It is a single TypeScript package, not a monorepo:

- **`src/engine/`** — the agent loop (`loop.ts`), tool implementations (bash,
  read/write/edit, glob/grep), compaction, permissions, pricing, system
  prompt, and both the Anthropic and OpenAI-compatible API clients.
- **`src/agent/`** — session/session-index persistence, provider config, MCP
  client wiring, skills, permission store, settings.
- **`src/commands/`** — slash-command registry/builtins and the `cli`,
  `config`, `doctor`, `mcp`, `update` subcommands.
- **`src/ui/`** — a **hand-rolled** alt-screen terminal UI: own ANSI/render/
  terminal layer, input box, overlay, status bar, markdown rendering, 12
  built-in color themes — no ratatui/ink/blessed.
- **`tests/`** — 71 test files, run via Vitest.
- **`scripts/` / `installer/`** — PowerShell/bash packaging scripts and an Inno
  Setup (`.iss`) installer definition for a compiled binary distribution.

Single build system (`tsc`), single test runner (`vitest`), one
`tsconfig.json` and one `package.json`. Total source: ~8.6k LoC across 84
files. The project is very young and moving fast: **329 commits since
2026-07-10** (11 days).

### Verification run for this review (at `c038a21` + fixes)

| Check | Command | Result |
|---|---|---|
| Build / type-check | `npx tsc -p tsconfig.json` | ✅ clean, exit 0 |
| Tests | `npx vitest run` | ✅ **648 passed** / 71 files (~4.4s) |
| Lint | `npx oxlint src tests` | ⚠️ 1 pre-existing warning (`nativeApp.ts:151`, `no-this-alias`) |

## 2. Prior review recommendations — now closed

The 2026-07-19 review's top gaps have all been addressed in the intervening
commits:

| 2026-07-19 gap | Status at `c038a21` |
|---|---|
| No CI | ✅ `.github/workflows/ci.yml` — lint + type-check/build + test matrix over Node 18/20/22, plus a separate `npm audit --audit-level=high` job; `release-smoke-test.yml` added alongside |
| No linter | ✅ oxlint configured (`.oxlintrc.json`), wired into `npm run lint` and CI |
| No documented architecture rules | ✅ `AGENTS.md` written — layer boundaries, provider-abstraction pattern, ~600/1000-line module ceiling, testing convention, error-handling boundaries |
| No dependency automation | ✅ `.github/dependabot.yml` present + CI audit job |
| TS 7 / `@types/node` 26 prerelease pins undocumented | ◻️ Still pinned via `^`; rationale still not written down (see §5) |
| `nativeApp.ts` trending toward a gravity well | ⚠️ Now **677 lines** (was 668) — has crossed AGENTS.md's own 600-line "deliberate decision to split" threshold (see §4) |

## 3. Security posture

The `bash` tool and file tools (`read`/`write`/`edit`/`glob`/`grep`) are the
primary attack surface: arbitrary command execution and filesystem access
driven by model output. There is **no sandbox layer** (no Landlock/Seatbelt/
Windows-sandbox equivalent); safety relies on a permission-prompt model
(`src/agent/permissionStore.ts`, `src/engine/permissions.ts`). Within that
model the reasoning is unusually careful — the allow-prefix-only-for-simple-
commands logic shows real thought about shell injection — but this pass found
two gaps in it, both now fixed in the working tree.

### Finding 1 — compound-command detection missed newline injection *(fixed)*

`isCompoundCommand` (`src/agent/permissionStore.ts`) exists so that a remembered
"allow `git`" rule cannot be ridden by a chained command. It caught `;`, `&&`,
`||`, `|`, backtick, `$(`, and `>` — but **not a newline**. Because `bash.ts`
hands the whole string to `sh -c` / `powershell -Command`, both of which treat
a newline as a statement separator, `git status\nrm -rf ~` had a
`commandPrefix` of `git`, was classified as *simple*, and was auto-allowed by a
`git` allow-rule. Bare `&` (background/chain) and `<` also slipped through.

**Fix:** pattern widened to `/[;&|` + "`" + `\n\r<>]|\$\(/`, covering newline,
`\r`, bare `&`, and `<`. Tab is deliberately excluded (argument whitespace, not
a separator). Tests added for newline/`\r\n`/`&`/`<` and a tab-negative case.

### Finding 2 — reads were unconfined (data-exfiltration path) *(fixed)*

`decidePermission` auto-allowed `Read` for *any* absolute path, in every mode,
with no cwd check — unlike edits, which enforce `isInsideCwd`. In default mode
the agent could read `~/.ssh/id_rsa`, `~/.aws/credentials`, or any `.env` with
no prompt, then exfiltrate via a Bash network call. This is the more likely
real-world exfiltration path than command execution, and the prior review's
security section did not cover it.

**Fix:** a `Read` resolving outside cwd now returns `"ask"`, mirroring the
existing outside-cwd edit guard (including under `bypassPermissions`); an
explicit remembered allow-rule for the path still wins. Scoped deliberately to
`Read` — `Glob`/`Grep` take a `pattern`/`path` rather than `file_path` and
remain unconfined; that residual is documented in-code and pinned by a test so
it is explicit rather than silent. Closing it is the natural follow-up (§5).

### Other notes

- Print/non-interactive mode auto-denies prompting tool calls by default;
  `acceptEdits`/`bypassPermissions` are explicit opt-outs, not default-on.
- `npm audit --audit-level=high` now runs in CI (new since the prior review).
- Credentials via `ANTHROPIC_API_KEY` env var only; no keyring equivalent —
  appropriate at this scale, worth revisiting if `~/.cloudcode/providers.json`
  ever holds secrets on disk.

## 4. Architecture assessment

### Strengths

1. **No accidental complexity from vendoring.** Talks to `/v1/messages` (and an
   OpenAI-compatible equivalent) directly, removing a whole class of
   subprocess/IPC/version-skew bugs and keeping `loop.ts` small enough to read
   in one sitting.
2. **Clean, now-documented module boundaries.** `engine` / `agent` / `commands`
   / `ui` are cleanly separated, and `AGENTS.md` codifies where new code goes
   and the `api.ts` vs `openaiApi.ts` provider pattern.
3. **Real type discipline.** `strict: true`, held to in practice.
4. **Test coverage keeps pace.** 71 test files map close to 1:1 with source
   modules; tests land in the same commits as features.
5. **Careful correctness details.** e.g. `bash.ts` disambiguates interrupt vs.
   timeout (checks `signal.aborted` before `killed`); `loop.ts` uses a
   non-mutating cache-control marker, a `MAX_LOOP_TURNS` circuit breaker, and a
   `finalizePendingToolInput` safety net for providers that drop
   `content_block_stop`.

### Concerns / technical debt

1. **`src/ui/nativeApp.ts` has crossed the project's own size line (677 > 600).**
   AGENTS.md says >600 lines needs "a deliberate decision to split," along the
   input / render-orchestration / overlay-menu seams already named there. This
   is the first file to test the rule the project just wrote for itself — a
   good candidate for the first extraction, though not urgent.
2. **The module-size ceiling is unmechanized.** It's a written guideline with
   no CI check; drift will only be caught by reviewer memory.
3. **Prerelease toolchain pins undocumented.** `typescript: ^7.0.2` and
   `@types/node: ^26.1.1` remain ahead of stable tracks with no recorded
   rationale or fallback.
4. **Packaging scripts remain untested.** `scripts/build-*.ps1/.sh` and
   `installer/cloudcode.iss` have no automated verification beyond the release
   smoke-test workflow; a broken packaging script would still mostly surface at
   release time.

## 5. Recommendations (prioritized)

1. **Confine `Glob`/`Grep` like `Read`** (Finding 2 residual). Apply the same
   outside-cwd "ask" to their `path`/`pattern` inputs so directory-walk reads
   can't sidestep the read confinement just added.
2. **Split `src/ui/nativeApp.ts`** along the input / render / overlay seams
   before it grows further — it is now over AGENTS.md's 600-line threshold.
3. **Mechanize the module-size ceiling** — a tiny CI step (or oxlint rule)
   failing on files over ~1,000 lines turns the AGENTS.md guideline into an
   enforced invariant.
4. **Document the TS 7 / `@types/node` 26 choice** in README/docs, or move to
   `~` pinning so a prerelease patch can't silently change build behavior.
5. **Add packaging-script coverage** (or lean harder on the release smoke test)
   so a broken installer surfaces before a release, not during one.

## 6. Verdict

At 11 days and 329 commits, cloudcode remains unusually disciplined, and it has
visibly acted on the last review: CI, linting, dependency automation, and a
written `AGENTS.md` all landed since `a5e0cf5`. This pass went a level deeper
into the permission model — the one part of the system standing in for a
sandbox — and found two real gaps: a newline-injection bypass of the
allow-prefix guard, and entirely unconfined reads as a data-exfiltration path.
Both are now fixed in the working tree, with tests, and the full suite is green
(648 passing). The remaining items are small and mostly preventive: finish read
confinement for `Glob`/`Grep`, split `nativeApp.ts` before it grows, and
mechanize the size ceiling the project has already committed to on paper.
