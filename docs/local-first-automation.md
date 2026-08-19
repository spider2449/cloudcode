# Local-first automation contracts

cloudcode's automation surface is local by default. It does not require a Git
host, hosted runner, telemetry endpoint, remote pack registry, or daemon. The
selected language-model provider remains the only allowed non-loopback endpoint
under `providerOnly`; `offlineStrict` requires a loopback provider.

## Structured runs and limits

`--output-format json` emits one schema-versioned result document.
`stream-json` emits monotonically sequenced envelopes and no human stdout.
Provider requests, wall time, and known-price cost can be bounded with
`--max-turns`, `--timeout`, and `--max-cost-usd`. Exit codes 0–7, 130 are stable
and documented in the README. Credentials and authorization values are redacted
from structured errors.

## Tasks and workers

Task manifests are version 2. Version 1 manifests load through an in-memory
migration with empty coordinator state, so existing isolated tasks remain
usable. Parent manifests durably reference every child task, role, state,
branch, worktree, provider/model, path ownership, limits, event log, target
commit, and integrated head.

The coordinator permits `research`, `implement`, `verify`, and `review` roles.
Workers never share writable worktrees. Implementation ownership is checked
both before scheduling and against the committed diff before integration.
Verify/review workers use a clean immutable implementation commit. Research
results are artifacts and cannot be integrated as code.

The worker scheduler defaults to concurrency one, rejects concurrency above
three, requires explicit parallel acknowledgement, multiplexes worker identity
into bounded JSONL logs, and propagates one abort signal to running jobs.
Cancellation waits for jobs to settle and records interrupted child state.

Integration is a two-step local operation. Preview validates both worktrees,
records heads and commits, checks ownership, and uses Git merge-tree conflict
detection without changing refs or worktrees. `--yes` is required for the final
argument-array cherry-pick. Failed or refused integration preserves worker
branches and worktrees for recovery.

## Workflow packs

Packs are linked from canonical local paths. Every declared resource is included
in the digest; stale content contributes nothing until relinked and re-enabled.
Pack MCP/LSP names are namespaced, command collisions fail closed, network
capability is denied outside `unrestricted`, and executable contributions remain
under project digest trust. Task manifests pin exact pack name/version/digest.

## Continuous maintenance

Maintenance analysis omits Write, Edit, Bash, and MCP rather than waiting for a
permission denial. Isolated verification executes a trusted validation profile
in an owned worktree and retains it if generated changes would be lost. Reports
record project HEAD, dirty fingerprint, config/pack digests, session, limits,
network mode, exit code, and comparison with the previous report. A per-project
lock prevents scheduler overlap; retention removes only non-symlink run folders
under that project's report root.

cloudcode does not install scheduled tasks. Invoke `cloudcode maintain run` from
Task Scheduler, cron, systemd timers, or a self-hosted runner. The built-in
offline dependency inventory is not a current vulnerability audit.

## Release verification

The release gate is:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
npm run package:npm
```

Manual local smoke checks use only inert/read-only operations:

```powershell
node dist/cli.js --help
node dist/cli.js pack validate examples/packs/reference-inert
node dist/cli.js maintain list
node dist/cli.js task list
```

Real temporary-Git integration tests additionally cover dirty source isolation,
Windows-safe paths, task resume/removal refusal, pack-pinned verification,
maintenance worktree retention, child-worker separation, cancellation,
ownership refusal, integration preview, and explicit cherry-pick.

### Verification evidence: 2026-08-19

The final Windows/PowerShell gate completed with 119 test files passing, 916
tests passing, one intentionally skipped test, zero high-severity audit findings,
and every source/test file below 600 lines. `npm run package:npm` produced
`cloudcode-0.1.0.tgz` with 156 files, including this guide, the pack schema, and
the inert reference pack. Lint reported only the two pre-existing unused imports
in `tests/lsp/autoInject.test.ts`.

All four compiled-CLI smoke commands above exited successfully. Pack validation
returned the inert pack's manifest and SHA-256 digest; maintenance listed the
five built-in profiles with their network modes; task listing read local state
without mutation. The real-Git worker tests also executed preview and explicit
cherry-pick paths rather than mocking Git.
