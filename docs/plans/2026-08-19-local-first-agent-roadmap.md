# Local-first automation and task-agent roadmap

## Goal

Evolve cloudcode from an interactive terminal coding agent into a local-first
engineering automation runtime without turning it into a provider router or a
cross-provider benchmark product.

The roadmap covers five product directions:

1. structured non-interactive automation and local/self-hosted CI;
2. isolated issue-to-verified-change task execution using Git worktrees;
3. locally installed domain workflow packs;
4. local, scheduled maintenance runs;
5. worktree-isolated multi-agent execution after the single-agent task model is
   proven reliable.

Provider routing and provider/model evaluation are explicitly out of scope.
Remote Git hosting integrations, hosted task execution, remote pack registries,
telemetry, and implicit upload/fallback behavior are also out of scope.

## Product position

cloudcode should remain a native, provider-agnostic terminal agent, but its
distinguishing contract becomes:

> A user can run, inspect, interrupt, resume, and reproduce an engineering task
> locally, with every direct network capability declared and every repository
> mutation isolated or attributable.

The interactive TUI remains the primary collaborative experience. New CLI
surfaces reuse the same `AgentSession`, engine loop, permission model, project
trust, sessions, MCP/LSP wiring, change journal, and system-prompt assembly.
There must not be a second automation-only agent engine.

The dependency order is deliberate:

```text
Phase 0: privacy boundary
    -> Phase 1: structured automation
        -> Phase 2: isolated task runner
            -> Phase 3: local workflow packs
            -> Phase 4: local maintenance
                -> Phase 5: isolated multi-agent execution
```

## Non-goals

- Do not automatically select or fall back between providers or models.
- Do not run the same task against several providers for comparison.
- Do not add a hosted cloudcode control plane, web dashboard, or telemetry.
- Do not push branches, open pull requests, post comments, or update issues.
- Do not install skills or packs from the network as part of an automated run.
- Do not infer that an arbitrary child process is offline from its command name.
- Do not make `engine/loop.ts` aware of worktree, task-manifest, scheduler, pack,
  Git-hosting, or UI persistence formats.
- Do not make multi-agent execution the first implementation milestone.

## Cross-cutting privacy and safety contract

### Network modes

Add a typed network policy owned by `src/agent/`, because it describes the
user's machine and execution environment rather than provider turn semantics:

```ts
export type NetworkMode = "offlineStrict" | "providerOnly" | "unrestricted";
```

Initial behavior:

- `offlineStrict`
  - only loopback provider endpoints are accepted;
  - HTTP/SSE MCP transports, update checks, remote skill installation, Git
    remote operations, and other cloudcode-owned egress are denied;
  - stdio MCP and LSP commands remain subject to existing content-digest project
    trust;
  - `Bash` is unavailable unless an enabled sandbox adapter can positively
    guarantee that child-process networking is disabled;
  - native Read/Write/Edit/Glob/Grep and LSP tools remain available.
- `providerOnly`
  - the selected provider endpoint may be non-loopback;
  - other cloudcode-owned egress remains denied;
  - ordinary `Bash` may be permitted by the existing permission system, but the
    UI and event log must state that arbitrary child-process egress is not
    contained. This mode must never be described as fully offline.
- `unrestricted`
  - network-capable features may run, still subject to their ordinary permission
    and project-trust checks;
  - external-state mutations such as push or PR creation remain outside this
    roadmap and are not enabled merely by choosing this mode.

Default new installations to `providerOnly` so the current direct Anthropic
setup continues to work without silently enabling unrelated network features.
Allow users who run a loopback provider to select `offlineStrict`. Persist only
`offlineStrict` and `providerOnly`; require `unrestricted` per invocation until
a later security review deliberately changes that policy.

### Direct-egress registry and audit

Every cloudcode-owned network entry point must declare a capability before it
can execute. The initial registry covers:

- selected provider base URL;
- HTTP/SSE MCP transport;
- `cloudcode update`;
- `/skill install` and `/skill update`;
- any future remote Git operation;
- any future pack installer.

Record decisions as local structured events containing capability, destination
host, mode, allow/deny result, and timestamp. Never record credentials, query
strings, request bodies, prompts, file contents, or provider responses. Store
the bounded log under `~/.cloudcode/audit/`, not in the repository.

This registry does not claim to observe or intercept networking performed by an
arbitrary Bash, LSP, or stdio MCP child. `offlineStrict` is only valid when those
children are disabled or launched by a sandbox adapter with a verified
no-network guarantee.

### Mutation and external-state rules

- Task automation never touches the user's primary worktree.
- Native Write/Edit changes continue to use the existing change journal.
- Bash and external-program mutations are bounded by the disposable task
  worktree rather than falsely presented as individually undoable.
- Removing a task worktree or local branch always requires an explicit
  confirmation flag and refuses dirty/unmerged state by default.
- No phase in this plan runs `git reset --hard`, `git checkout --`, `git clean`,
  or `git stash` against a user's existing worktree.
- Commands that would alter remote state are absent, not merely hidden behind a
  permissive flag.

## Architecture boundaries

Follow the existing repository ownership rules:

- `src/engine/`
  - provider-neutral execution limits, structured engine event data, tool
    capability metadata, and sandbox-neutral tool availability;
  - no task manifests, worktree lifecycle, schedule files, or pack discovery.
- `src/agent/`
  - network policy and audit persistence, task/worktree manifests, workflow
    packs, maintenance profiles/runs, sandbox adapters, and multi-agent
    coordination;
  - services return typed data rather than terminal-formatted strings.
- `src/commands/`
  - CLI subcommands and slash commands validate input and orchestrate agent
    services; they do not implement Git, scheduling, or execution logic.
- `src/ui/`
  - overlays and views for approvals, task state, and event presentation;
  - no provider, Git, scheduler, or persistence logic.

Every new source module receives a corresponding focused test file. Split a
module before it approaches 600 lines; do not expand `nativeApp.ts`,
`builtins.ts`, `session.ts`, or `loop.ts` into the owner of a new subsystem.

## Shared data contracts

### Automation events

Define a versioned discriminated union that both print mode and stored task runs
consume:

```ts
interface EventEnvelope<T extends AutomationEvent = AutomationEvent> {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId?: string;
  taskId?: string;
  event: T;
}
```

Required initial event kinds:

- `run.started` and `run.finished`;
- `assistant.text_delta` and `assistant.message`;
- `tool.started` and `tool.finished`;
- `permission.requested` and `permission.resolved`;
- `limit.reached`;
- `network.decision`;
- `checkpoint.completed`;
- `error`.

JSON output emits one final object with result metadata. `stream-json` emits one
JSON object per line and never mixes human text into stdout. Diagnostics and
human-readable progress go to stderr only in text mode. Event ordering must be
stable and sequence numbers must be monotonically increasing within one run.

### Run limits

Add limits at the provider-neutral execution boundary:

```ts
interface RunLimits {
  maxTurns?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
}
```

- `maxTurns` counts provider requests, including tool-result continuations, not
  user messages.
- `timeoutMs` covers readiness plus the complete run and aborts through the
  existing signal path.
- `maxCostUsd` is accepted only when pricing for the selected model is known.
  Unknown pricing produces a configuration error rather than pretending to
  enforce a cap.
- Hitting a limit stops before another provider request or tool execution,
  persists the session/checkpoint state, emits `limit.reached`, and exits with a
  documented nonzero code.

### Exit codes

Reserve and document stable codes:

```text
0  completed successfully
1  provider/engine execution error
2  invalid CLI or configuration
3  permission or project-trust denial
4  run limit reached
5  verification failed
6  task/worktree state conflict
7  privacy/network-policy denial
130 interrupted by user
```

Do not expose raw provider HTTP status codes as process exit codes.

## Phase 0: verifiable local-first boundary

This phase precedes new automation because every later command needs the same
privacy semantics.

### Implementation

1. Add `src/agent/networkPolicy.ts` for URL classification, loopback detection,
   capability decisions, and typed denial reasons.
2. Add `src/agent/networkAudit.ts` for bounded, atomic local JSONL persistence
   with secret-free records and retention.
3. Add `networkMode` to settings and `/config`; add `--network-mode` for
   per-invocation narrowing. A CLI flag may make policy stricter than persisted
   settings without confirmation, but not more permissive.
4. Gate provider startup, HTTP/SSE MCP connection, update, and skill repo network
   commands through the same policy service.
5. Add tool-availability filtering so `offlineStrict` can remove `Bash` when no
   verified sandbox adapter exists. Do not branch on providers inside the loop.
6. Surface the effective network mode and its Bash guarantee in `cloudcode
   config`, `cloudcode doctor`, `/config`, and the TUI status/initial notice.
7. Document the distinction between cloudcode-owned egress and uncontained child
   processes prominently.

### Likely files

- Add `src/agent/networkPolicy.ts`
- Add `src/agent/networkAudit.ts`
- Modify `src/agent/settings.ts`
- Modify `src/agent/session.ts`
- Modify `src/engine/tools/types.ts`
- Modify `src/engine/registry.ts`
- Modify `src/engine/mcpClient.ts`
- Modify `src/commands/cli/config.ts`
- Modify `src/commands/cli/doctor.ts`
- Modify `src/commands/builtins.ts`
- Modify `src/cliArgs.ts`
- Modify `src/printMode.ts`
- Modify `src/ui/usageTracker.ts` or the narrow status-state owner
- Add matching focused tests for every new module and extend existing wiring
  tests rather than creating a monolithic privacy test.

### Completion criteria

- `offlineStrict` rejects every known cloudcode-owned non-loopback connection
  before a socket/client is created.
- Strict mode does not expose ordinary Bash when no verified sandbox is active.
- `providerOnly` permits exactly the selected provider endpoint and labels Bash
  as uncontained.
- Audit records contain no credentials, prompts, paths, request bodies, or query
  strings.
- Changing project MCP/LSP config still invalidates existing digest trust.

## Phase 1: structured non-interactive automation

### User-facing interface

```powershell
cloudcode -p "review the current diff" --output-format json
cloudcode -p "run focused checks" --output-format stream-json --max-turns 8 --timeout 10m
cloudcode -p "fix the type error" --max-cost-usd 1.50
```

Text remains the default for backward compatibility. JSON modes are intended
for local scripts and self-hosted CI and must remain useful without GitHub or
another hosted integration.

### Implementation

1. Extract print event adaptation from `src/printMode.ts` into small modules
   under `src/print/` rather than growing the existing file indefinitely.
2. Add strict duration and positive-number parsers to CLI argument handling.
3. Add the versioned event schema and one serializer per output format.
4. Extend the engine/session execution contract with `RunLimits`, preserving
   the existing per-tool and per-turn error boundaries.
5. Include session ID, duration, provider/model name, usage, cost when known,
   checkpoint summary, finish reason, and exit code in the final JSON result.
6. Redact provider errors before structured output if they contain configured
   API keys or authorization header values.
7. Ensure Ctrl+C emits a final interrupted event when stdout is still writable,
   closes checkpoints, persists the session, and returns 130.
8. Document a stable compatibility policy: additive event fields are allowed
   within schema version 1; removing/renaming fields requires version 2.

### Likely files

- Add `src/print/events.ts`
- Add `src/print/serialize.ts`
- Add `src/print/runLimits.ts`
- Modify `src/printMode.ts`
- Modify `src/cliArgs.ts`
- Modify `src/engine/loop.ts`
- Modify `src/agent/session.ts`
- Extend `src/engine/messages.ts` only for genuinely engine-owned typed data
- Add `tests/print-events.test.ts`
- Add `tests/print-serialize.test.ts`
- Add `tests/runLimits.test.ts`
- Extend `tests/printMode.test.ts`, `tests/cliArgs.test.ts`,
  `tests/engine-loop.test.ts`, and `tests/session-integration.test.ts`

### Completion criteria

- JSON and stream-json stdout parse without inspecting stderr.
- Two identical fixture runs produce the same event ordering except documented
  time, ID, provider-output, and duration fields.
- Limits stop before excess work and use the documented exit code.
- Unknown pricing cannot silently bypass `--max-cost-usd`.
- Text-mode behavior remains compatible with existing scripts.

## Phase 2: isolated local task runner

### User-facing interface

```powershell
cloudcode task start "fix the login timeout"
cloudcode task list
cloudcode task show <task-id>
cloudcode task resume <task-id>
cloudcode task verify <task-id>
cloudcode task review <task-id>
cloudcode task remove <task-id> --yes
```

`task start` creates a local branch and a linked worktree outside the repository,
then starts a normal interactive cloudcode session rooted in that worktree. It
does not push or open a PR. The user's original worktree and its staged,
unstaged, and untracked changes are never copied, stashed, reset, or modified.

### Task state

Persist an atomic manifest under `~/.cloudcode/tasks/<task-id>/manifest.json`:

```ts
type TaskState =
  | "created"
  | "planning"
  | "awaitingApproval"
  | "implementing"
  | "verifying"
  | "reviewReady"
  | "completed"
  | "failed"
  | "interrupted"
  | "conflicted";
```

The manifest records repository identity, canonical source path, worktree path,
base commit, local branch, session ID, state transitions, selected verification
profile, network mode, limits, and artifact paths. It must not record prompts or
file contents unless they already belong to the session transcript.

### Planning and approval

- The first task turn researches the worktree and writes a plan to the
  repository-required `docs/plans/<date>-<name>.md` path.
- Parse all applicable `AGENTS.md` files before proposing the plan path and
  validation commands.
- Default to `awaitingApproval` after the plan. Implementation begins only from
  an explicit user action in interactive mode or `task resume --approve-plan`.
- A later opt-in unattended mode may be considered separately; it is not part
  of this roadmap.

### Worktree service

1. Add an agent-layer Git runner using `execFile` with argument arrays and
   bounded stdout/stderr.
2. Resolve repository root/common dir and reject bare repositories, submodule
   ambiguity, existing branch collisions, unsupported Git versions, and a base
   commit that cannot be resolved locally.
3. Create worktrees under `~/.cloudcode/worktrees/<repository-id>/<task-id>/`
   with a deterministic safe local branch name.
4. Never fetch. All refs must already exist locally.
5. On resume, verify worktree registration, canonical path, repository common
   directory, branch, HEAD/base ancestry, and manifest identity.
6. `task remove --yes` refuses dirty state or unmerged commits unless an
   additional explicit destructive override is designed and reviewed later.
7. Reconcile stale manifests read-only and give recovery instructions; do not
   silently prune directories or branches.

### Verification and review

- Read validation commands from applicable project instructions and an optional
  project-local `.cloudcode/task.json` schema.
- Project-local commands are executable configuration and join the existing
  content-digest trust boundary.
- Run commands sequentially with timeout, output caps, interrupt support, and
  structured events.
- `task verify` does not edit files.
- `task review` reuses `gitReview.ts`, comparing the task branch/worktree against
  the recorded base commit, and writes a local report artifact.
- Generate a local PR-ready summary containing intent, changed files, validation
  evidence, known limitations, and review findings. Do not contact a Git host.

### Likely files

- Add `src/agent/taskManifest.ts`
- Add `src/agent/worktree.ts`
- Add `src/agent/taskRunner.ts`
- Add `src/agent/taskVerification.ts`
- Extend `src/agent/gitReview.ts`
- Add `src/commands/cli/task.ts`
- Modify `src/cliArgs.ts`
- Modify `src/cli.tsx`
- Add a narrow task picker/controller under `src/ui/` only if interactive resume
  cannot reuse the existing picker ownership cleanly
- Add `tests/taskManifest.test.ts`
- Add `tests/worktree.test.ts`
- Add `tests/taskRunner.test.ts`
- Add `tests/taskVerification.test.ts`
- Add `tests/cliTask.test.ts`
- Extend session, project-trust, Git-review, and packaging tests as required

### Completion criteria

- Starting and completing a task leaves the original worktree byte-for-byte and
  index-for-index unchanged.
- No task command fetches, pushes, or calls a Git-hosting API.
- Resume rejects identity drift instead of attaching to the wrong worktree.
- Plan approval is explicit and preserved across process restarts.
- Verification output is bounded, interruptible, structured, and attributable
  to the exact task commit/worktree state.
- Dirty worktrees cannot be removed accidentally.

## Phase 3: local workflow packs

### Purpose

Turn the existing skills, local stdio MCP, LSP, instructions, and validation
commands into installable domain workflows without adding a network registry.
Initial target domains can include Houdini, Maya, Unreal, Unity, embedded
toolchains, or organization-specific internal stacks.

### Local pack shape

```text
my-pack/
  cloudcode-pack.json
  skills/
    diagnose/SKILL.md
  mcp.json
  lsp.json
  validations.json
  instructions.md
```

The versioned manifest declares name, version, description, supported
platforms, required executables, contributed resources, and capabilities:

```ts
type PackCapability =
  | "readProject"
  | "writeProject"
  | "runProcess"
  | "localMcp"
  | "network";
```

Network capability is rejected for enabled packs under `offlineStrict` and
`providerOnly` in this roadmap. A pack declaring it remains inspectable but
cannot be enabled.

### User-facing interface

```powershell
cloudcode pack validate D:\packs\houdini
cloudcode pack link D:\packs\houdini
cloudcode pack list
cloudcode pack inspect houdini
cloudcode pack enable houdini --project
cloudcode pack disable houdini --project
cloudcode pack unlink houdini --yes
```

There is no URL form. `link` records a canonical local path and manifest digest;
it does not copy or download dependencies. Changed content invalidates prior
enablement/trust and requires re-inspection.

### Implementation

1. Add strict manifest parsing with unknown-key preservation for forward
   compatibility and human-readable validation failures.
2. Add user-level links under `~/.cloudcode/packs/links.json` and project-level
   enablement under `.cloudcode/packs.json`.
3. Treat project enablement as configuration, but any contributed command or
   stdio MCP entry remains executable config governed by project trust.
4. Merge contributed skills through the existing skill precedence rules without
   allowing a pack to overwrite built-in commands.
5. Merge LSP/MCP entries by explicit namespaced identifiers. Reject collisions
   rather than relying on scan order.
6. Expose validation profiles to the task runner; do not let packs call task
   services directly.
7. Add `pack doctor` output for missing executables and platform mismatch.
8. Ship only a schema, authoring guide, and inert fixture/reference packs first.
   Add a real domain pack only after its executable trust and validation flow is
   exercised end to end on the target application.

### Likely files

- Add `src/agent/packs.ts`
- Add `src/agent/packManifest.ts`
- Add `src/agent/packLinks.ts`
- Add `src/commands/cli/pack.ts`
- Modify `src/agent/skills.ts`
- Modify `src/agent/mcp.ts`
- Modify `src/engine/lsp/config.ts`
- Modify `src/agent/projectTrust.ts`
- Modify `src/cliArgs.ts`
- Add one corresponding test module per production module and focused wiring
  extensions for skills, MCP, LSP, trust, CLI, doctor, and packaging

### Completion criteria

- Packs are discoverable and usable entirely from local paths.
- Manifest or executable-config changes invalidate the previous digest.
- No pack can silently add a process, network transport, or built-in command
  override.
- Disabling a pack removes all of its contributed skills, MCP/LSP entries, and
  validation profiles from the next session.
- A task manifest records the exact pack names, versions, and digests used.

## Phase 4: local continuous maintenance

### Purpose

Run repeatable, bounded, initially read-only engineering checks locally or on a
self-hosted runner. cloudcode does not install a daemon and does not edit the OS
scheduler itself.

### User-facing interface

```powershell
cloudcode maintain list
cloudcode maintain run health
cloudcode maintain run docs-drift --output-format json
cloudcode maintain history
cloudcode maintain show <run-id>
```

Scheduling is delegated to Windows Task Scheduler, cron, systemd timers, or a
self-hosted CI runner invoking the same command. Documentation may generate a
command/script template, but cloudcode never registers a scheduled task without
a separate future design and explicit user authorization.

### Profile model

Profiles come from user config, project config, or enabled local workflow packs:

```ts
interface MaintenanceProfile {
  name: string;
  prompt: string;
  execution: "analysis" | "isolatedVerification";
  validationProfile?: string;
  limits: RunLimits;
  networkMode: "offlineStrict" | "providerOnly";
}
```

- `analysis` sessions receive only native read/search and read-only LSP tools;
  Write, Edit, Bash, and mutation-capable MCP tools are absent rather than
  waiting for a permission denial.
- `isolatedVerification` creates a Phase 2 worktree and may run a trusted local
  validation profile there. Generated files can affect only that owned
  worktree, never the user's source worktree. If verification leaves changes,
  retain the worktree for inspection instead of force-removing it.

Initial built-in templates:

- repository health summary;
- current local test-failure diagnosis;
- documentation/code drift review;
- TODO and technical-debt inventory;
- local dependency inventory using only checked-in manifests/lockfiles and
  already installed tools/data.

Do not label an offline dependency inventory as a current vulnerability audit.
Security-advisory freshness requires external data and is outside the accepted
offline scope.

### Implementation

1. Add tolerant config loaders for user and project maintenance profiles;
   project commands participate in executable-config trust.
2. Add a per-project run lock so schedulers cannot overlap maintenance runs.
3. Execute analysis through structured print mode with a strict read-only tool
   allowlist, declared network mode, run limits, and no plan/implementation
   continuation. Execute validation commands only in a Phase 2 worktree.
4. Store bounded reports and event logs outside the repository under
   `~/.cloudcode/projects/<project-id>/maintenance/<run-id>/`.
5. Record project HEAD, dirty-state fingerprint, configuration/pack digests,
   session ID, start/end time, exit code, and verification evidence.
6. Add retention by run count and byte size. Pruning removes only reports owned
   by the same project identity and never follows symlinks.
7. Make report changes detectable: repeated identical findings can be grouped,
   while new/resolved findings remain visible without requiring a remote service.

### Likely files

- Add `src/agent/maintenanceConfig.ts`
- Add `src/agent/maintenanceRuns.ts`
- Add `src/agent/runLock.ts`
- Add `src/commands/cli/maintain.ts`
- Modify `src/cliArgs.ts`
- Modify `src/cli.tsx`
- Reuse structured print serializers and task verification services
- Add one focused test file per module plus CLI/session integration tests

### Completion criteria

- Maintenance cannot mutate the user's source worktree in v1. Analysis mode
  cannot mutate any project worktree; isolated verification may mutate only its
  owned worktree and retains it when cleanup would discard evidence.
- Overlapping invocations produce a clear state/exit-code response, not two
  concurrent sessions.
- Reports are reproducibly tied to local repository/configuration state.
- Retention cannot delete outside the intended project report directory.
- No built-in profile requires a Git host, remote scheduler, telemetry, or
  online advisory database.

## Phase 5: worktree-isolated multi-agent execution

Start this phase only after Phase 2 task resume, cleanup, verification, and
conflict handling have been used successfully in real repositories.

### Initial model

- One coordinator owns the parent task manifest and user interaction.
- Each worker receives a bounded role, its own child task ID, local branch,
  worktree, session, run limits, event log, and checkpoint journal.
- Workers never share a writable worktree.
- All workers use the explicitly selected provider/model; there is no routing or
  provider comparison.
- Default concurrency is one. Parallelism above one requires an explicit flag,
  with a small hard cap and a visible cost/privacy warning for non-loopback
  providers.

Initial roles:

- `research`: read-only evidence and proposed approach;
- `implement`: code changes against an approved plan;
- `verify`: read-only validation of an implementation branch;
- `review`: read-only severity-ranked review of the resulting diff.

### Integration rules

1. Research output is an artifact consumed by the coordinator, not a code
   branch to merge.
2. One implementation worker owns a given path set at a time. Overlapping
   ownership requires coordinator/user resolution before work starts.
3. Verification and review run against immutable recorded commits or a frozen
   worktree state.
4. The coordinator previews local commits/diffs and conflicts before any
   cherry-pick or patch application.
5. Integration is local and requires explicit approval. No push or PR action is
   introduced.
6. Failed integration leaves every worker branch/worktree intact for inspection.
7. Cancellation propagates to workers, waits for child processes to stop, closes
   checkpoints/events, and records the exact final state of each worktree.

### Implementation

1. Add a coordinator-owned state machine and child-task references to the task
   manifest format using a versioned migration.
2. Add bounded scheduling with cancellation and per-worker event multiplexing.
3. Add path-ownership planning based on the approved plan and Git diff checks;
   treat it as conflict prevention, not a security boundary.
4. Add local integration preview and conflict detection services using argument-
   array Git calls.
5. Add a TUI task view or concise stream-json worker identifiers without moving
   coordinator state into `nativeApp.ts`.
6. Test with real temporary Git repositories, including Windows path behavior,
   cancellation, conflicting edits, failed workers, interrupted integration,
   resume, and cleanup refusal.

### Likely files

- Add `src/agent/taskCoordinator.ts`
- Add `src/agent/workerScheduler.ts`
- Add `src/agent/taskIntegration.ts`
- Version and extend `src/agent/taskManifest.ts`
- Extend `src/commands/cli/task.ts`
- Add a narrowly owned UI controller/view if required
- Add corresponding focused tests and multi-repository integration fixtures

### Completion criteria

- No two workers write the same worktree.
- Parent/child task state survives process interruption and resume.
- Worker failures cannot silently discard another worker's successful branch.
- Integration is previewed, local, explicit, and recoverable from retained
  branches/worktrees.
- Multi-agent runs obey the same network mode, trust, limits, audit, event, and
  retention contracts as single-agent runs.

## Delivery and commit sequence

Keep commits focused and include tests with their production changes:

1. Network policy types, direct-egress gates, and secret-free audit.
2. Network-mode CLI/config/UI wiring and strict tool availability.
3. Versioned automation events and serializers.
4. Provider-neutral turn/time/cost limits and stable exit codes.
5. Structured print-mode CLI and documentation.
6. Task/worktree manifest and identity-safe lifecycle.
7. Task planning/approval/resume flow.
8. Verification, local review, and task artifacts.
9. Local workflow-pack manifest/link/trust foundation.
10. Pack contributions to skills, MCP/LSP, and verification profiles.
11. Maintenance profiles, locking, reports, and retention.
12. Multi-agent manifest/coordinator foundation.
13. Worker isolation, scheduling, integration preview, and UI/events.
14. Final documentation, packaging checks, and manual end-to-end evidence.

Do not combine all phases into one branch or release. Recommended release gates:

- Release A: Phases 0-1;
- Release B: Phase 2;
- Release C: Phases 3-4;
- Release D: Phase 5.

## Verification strategy

After each focused commit, run the directly affected tests. At every release
gate run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```

Manual gates must use disposable repositories and verify:

1. loopback `offlineStrict` operation with no exposed Bash and denied HTTP MCP;
2. remote-provider `providerOnly` operation with unrelated egress denied and
   the Bash containment limitation visibly disclosed;
3. text, JSON, and stream-json automation output and interrupt behavior;
4. a task created from a dirty primary worktree without changing that worktree;
5. task interruption, process restart, resume, verify, review, and safe cleanup;
6. pack digest invalidation after manifest/command changes;
7. two scheduler invocations contending for one maintenance lock;
8. multi-agent cancellation and conflict handling with every worktree retained.

Network-denial tests must inject fake connection/process factories and prove the
factory was never invoked; tests that merely assert an error after connection
startup are insufficient.

## Overall completion criteria

- All five accepted product directions are available without a hosted cloudcode
  service, remote Git integration, model routing, or provider benchmarking.
- Every cloudcode-owned network connection is classified, policy-checked, and
  recorded without sensitive payloads.
- Strict offline guarantees are never claimed while an uncontained arbitrary
  child process can run.
- Structured automation has a stable schema, limits, exit codes, interruption,
  and session/checkpoint persistence.
- Task execution cannot alter the user's primary worktree and never fetches,
  pushes, or opens a PR.
- Local workflow packs cannot silently introduce executable or network
  capability.
- Maintenance is read-only, locally scheduled, locked, attributable, and
  retained safely.
- Multi-agent workers are isolated by worktree and integrated only after an
  explicit local preview.
- Every production module has corresponding focused tests and remains within
  the repository's size guidance.
- Lint, size checks, build, full tests, high-severity audit, packaging checks,
  and the listed manual gates pass at each applicable release boundary.
