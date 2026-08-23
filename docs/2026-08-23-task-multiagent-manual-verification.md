# Manual verification checklist — task runner and multi-agent (roadmap Phases 2 & 5)

Date: 2026-08-23

Run every gate in a disposable repository with a working provider (API key or
loopback endpoint). Each item lists the exact commands, the expected outcome,
and the roadmap criterion it evidences. Check items off as verified; anything
failing is a bug, not a note.

Setup:

```powershell
mkdir D:\temp\cc-verify; cd D:\temp\cc-verify
git init verify-repo; cd verify-repo
git config user.email you@example.com; git config user.name you
"hello" | Set-Content README.md; git add .; git commit -m init
```

## Phase 2 gates

### 1. Task start leaves the primary worktree untouched
- [ ] Make the source worktree dirty first: `"wip" | Add-Content README.md` (do not commit).
- [ ] `cloudcode task start "add a greeting function"`
- Expected: command succeeds; a worktree exists under `~/.cloudcode/worktrees/`; a manifest exists under `~/.cloudcode/tasks/<task-id>/manifest.json`.
- [ ] In the ORIGINAL directory: `git status --porcelain` still shows only your own ` M README.md`; `git diff` byte-identical to before.
- Criterion: roadmap 2.1 — "Starting and completing a task leaves the original worktree byte-for-byte and index-for-index unchanged."

### 2. Plan approval is explicit and survives restart
- [ ] Let the first turn produce a plan under `docs/plans/`. State should be `awaitingApproval`.
- [ ] Close the process (Ctrl+C). Re-run `cloudcode task resume <task-id>` WITHOUT `--approve-plan`.
- Expected: implementation has NOT started; state still `awaitingApproval`.
- [ ] `cloudcode task resume <task-id> --approve-plan`
- Expected: implementation begins. Criterion: "Plan approval is explicit and preserved across process restarts."

### 3. Verify / review / remove safety
- [ ] After implementation completes: `cloudcode task verify <task-id>` — expected: runs validation commands read-only, structured output, does NOT edit files (`git status` inside the task worktree unchanged afterwards).
- [ ] `cloudcode task review <task-id>` — expected: local report artifact written; no network calls to any Git host (watch with `--network-mode offlineStrict` if desired).
- [ ] With UNMERGED commits in the task branch: `cloudcode task remove <task-id> --yes` — expected: REFUSES (dirty/unmerged protection), exit code 6 territory per roadmap.
- [ ] After merging/inspecting, removal succeeds.

### 4. Resume rejects identity drift
- [ ] Start a task; then manually move/rename its worktree directory, or reset its branch HEAD.
- [ ] `cloudcode task resume <task-id>`
- Expected: clear error about identity drift; it must NOT attach to a wrong worktree. Criterion: "Resume rejects identity drift instead of attaching to the wrong worktree."

## Phase 5 gates (multi-agent)

### 5. Worker isolation
- [ ] From an approved-plan parent task: `cloudcode task worker start <parent-id> research`, then `implement --paths src/greet.ts`.
- [ ] `cloudcode task workers <parent-id>`
- Expected: each worker has its OWN child task id, branch, and worktree; no two workers share one writable worktree. Criterion: "No two workers write the same worktree."

### 6. Cancellation propagates and preserves evidence
- [ ] With workers running: `cloudcode task cancel-workers <parent-id>`.
- Expected: all workers stop; each worktree/branch retained at its exact final state; manifests record final states; no orphaned bun/node child processes (`Get-Process bun,node` afterwards).

### 7. Integration previewed, local, explicit
- [ ] `cloudcode task integrate <parent-id> <worker-id>` without `--yes`
- Expected: shows the diff/conflict preview; performs nothing yet.
- [ ] With `--yes`: cherry-pick/patch applies locally; NO push, NO PR, no remote calls of any kind.
- [ ] Force a conflicting worker change first; integration attempt — expected: conflict surfaced, integration aborted, ALL worker branches/worktrees still present for inspection.

### 8. Multi-agent runs obey shared contracts
- [ ] Repeat gate 5 with saved `networkMode=offlineStrict` and loopback provider: workers' Bash (if sandbox available) contained; audit log gains entries; run limits respected per worker.
- [ ] Interrupt the coordinator mid-flight (Ctrl+C): parent/child manifest state survives restart (`task show <parent-id>` consistent); resume works or fails loudly — never silently discards another worker's successful branch.

## Sign-off

Record per gate: date, machine, provider used, PASS/FAIL, notes. A full pass
of gates 1–7 plus gate 8 closes the last roadmap item ("Phase 5 after real-
repository validation") tracked from AGENTS.md's release-gate philosophy.
