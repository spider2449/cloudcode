# Safe change checkpoints, undo, and Git review

## Goal

Give users a trustworthy way to inspect and reverse cloudcode's native file
edits without using destructive Git operations or overwriting unrelated work.
Every interactive or print-mode turn gets an automatic checkpoint when it
successfully changes a file through `Write` or `Edit`. The user can inspect the
session-owned changes with `/changes` and `/diff`, preview and apply `/undo`, and
ask the model to review the repository's complete Git diff with `/review`.

The implementation must preserve the current architecture:

- file mutation semantics remain in `src/engine/tools/`;
- checkpoint persistence and repository inspection live in `src/agent/`;
- slash commands only orchestrate agent/UI operations;
- the provider-neutral turn loop remains unaware of checkpoint file formats;
- no command may call `git reset`, `git checkout`, `git restore`, `git stash`,
  or otherwise rewrite repository state through Git.

## User-facing behavior

### Automatic checkpoints

- `AgentSession.send()` opens a checkpoint immediately before a turn begins.
- The checkpoint records only successful filesystem changes made by the native
  `Write` and `Edit` tools during that turn.
- Multiple edits to the same file in one turn retain the first before-image and
  the final after digest, so undo restores the state from before the turn.
- A turn that performs no native file mutation creates no visible checkpoint.
- Interrupted and failed turns still commit a checkpoint if a native tool
  changed a file before interruption/failure.
- Checkpoints persist with the session and remain available after `/resume` or
  `cloudcode --continue`.

### `/changes`

`/changes` prints the changes owned by the current cloudcode session, newest
checkpoint first. Each row shows checkpoint ID, turn time, file status
(`added`, `modified`, or `restored`), path, and whether undo is available.

`/changes latest` limits output to the most recent non-undone checkpoint.
If Bash or an external program has changed the working tree, `/changes` does
not claim ownership of those files; `/review` is the complete repository view.

### `/diff [path]`

`/diff` shows a bounded unified diff between each session-owned file's first
captured before-image and its current contents. Supplying a path restricts the
output to that file. Binary files show size and digest changes instead of being
decoded as text. Output truncation must report how many files/bytes were
omitted rather than silently cutting the diff.

### `/undo [--yes]`

- `/undo` is a preview only. It lists exactly which files the latest eligible
  checkpoint would restore or remove and instructs the user to run
  `/undo --yes`.
- `/undo --yes` restores only the latest non-undone checkpoint. Arbitrary
  out-of-order undo is not supported in v1 because later checkpoints may depend
  on earlier file states.
- Before changing a file, undo verifies that its current digest and filesystem
  identity still match the recorded after state. If any file differs, the
  entire undo is refused and no file is modified.
- A file created by the checkpoint is removed only when its current content
  still matches the recorded after digest.
- A modified file is restored byte-for-byte from its before-image using an
  atomic replace.
- A successful undo is itself recorded as a journal event, so `/changes` can
  explain what happened. Redo is explicitly out of scope for v1.
- `/undo` is unavailable while a turn is running.

### `/review [--staged]`

- In a Git worktree, `/review` gathers a bounded, read-only status and diff and
  sends a review prompt through the current session. The prompt separates
  session-owned paths from other working-tree changes and asks for
  severity-ranked findings with exact file references.
- The default reviews unstaged plus staged changes; `--staged` reviews only the
  index.
- Git is invoked with `--no-ext-diff` and `--no-textconv`; no hook or external
  diff driver is allowed to execute.
- In a non-Git directory, the command falls back to the native checkpoint diff.
- If the bounded diff is truncated, the model is told that review coverage is
  incomplete.

## Explicit scope and safety limits

### What v1 can undo

Only `Write` and `Edit` calls are guaranteed recoverable. The `Bash` tool can
run arbitrary programs and mutate an unbounded set of paths; pretending those
effects are reversible would be unsafe. Bash/external changes appear in Git
review where Git can see them, but `/undo` never restores them.

MCP tools are also outside the checkpoint contract in v1. A later extension
may let a tool declare transactional file mutations through the same observer
interface.

### Existing user changes

The before-image is the exact state immediately before cloudcode's first native
edit in the turn, even when that state already contains uncommitted user work.
Undo therefore returns to the user's pre-turn state rather than to `HEAD`.
There is no Git reset/stash fallback.

### Storage and retention

Store checkpoint data outside the repository under:

```text
~/.cloudcode/checkpoints/<session-id>/
  manifest.json
  blobs/<sha256>
```

The manifest records the canonical project path, session ID, checkpoint
metadata, requested and canonical file identities, before state, after digest,
and undo state. Blobs are content-addressed byte snapshots and are written
atomically.

Initial limits:

- maximum before-image: 10 MiB per file;
- maximum retained checkpoint storage: 100 MiB per session;
- maximum retained checkpoints: 20 per session;
- unified diff payload: 200 KiB per command/review prompt.

If a file exceeds a limit, record the change as `undoUnavailable` with the
reason and expose that state in `/changes`; never imply that it is protected.
Prune the oldest completed checkpoints after a new checkpoint is committed,
but never prune the newest eligible undo checkpoint during that commit.

Malformed manifests fall back to an empty journal with a visible warning. They
must never cause startup failure or trigger restoration from partially parsed
data.

## Architecture

### Engine-owned mutation observer contract

Add a provider- and persistence-neutral contract to
`src/engine/tools/types.ts`:

```ts
export interface FileMutationToken {
  readonly id: string;
}

export interface FileMutationObserver {
  before(path: string): Promise<FileMutationToken>;
  after(token: FileMutationToken): Promise<void>;
}
```

Add an optional observer to `ToolContext`. `Write` and `Edit` resolve the path
once, call `before()` immediately before their first write, and call `after()`
in `finally` so partial changes are detected even when the write reports an
error. When no observer is present, behavior remains unchanged.

Extract the shared absolute-path resolution into a small engine helper so
permission decisions, mutation capture, and actual writes do not drift. The
observer interface must not import `agent/changeJournal.ts` or expose storage
details to the engine.

### Agent-owned journal

Add `src/agent/changeJournal.ts` with one stateful `ChangeJournal` per
`AgentSession`. It implements `FileMutationObserver` and owns:

- opening/closing an automatic turn checkpoint;
- exact byte before-image capture;
- SHA-256 digest and file identity calculation;
- coalescing repeated edits to the same canonical file;
- atomic manifest/blob persistence;
- retention enforcement;
- formatted change data for commands;
- conflict-checked, all-or-nothing undo.

For an existing path, record `lstat`, resolved real path, and content digest.
For a new path, record the canonical parent plus requested basename. Undo must
refuse if a symlink or parent identity changed, preventing a recorded path from
being redirected to a different target.

The journal API should return typed data, not presentation strings:

```ts
interface ChangeSummary { /* checkpoint and file metadata */ }
interface UndoPreview { /* exact operations or conflicts */ }
interface UndoResult { /* restored paths and journal event */ }
```

Formatting belongs in `src/commands/changeFormatting.ts` so the same typed
results can later support JSON print output.

### Session lifecycle

`AgentSession.start()` opens the journal for the session ID and verifies the
stored canonical project path. A mismatched project path makes the journal
read-only and emits a warning; it must never apply checkpoints from another
project.

`AgentSession.send()` opens a turn checkpoint after MCP readiness and just
before `runTurn()`. It closes the checkpoint in `finally`, after all tool work
has stopped but before background memory extraction begins. Expose typed
methods for listing changes, building diffs, previewing undo, applying undo,
and constructing review input.

Project switching disposes the old session/journal and creates a new pairing;
it does not carry checkpoints across projects. Session compaction changes only
conversation history and does not rewrite checkpoint history.

### Git review service

Add `src/agent/gitReview.ts`. It uses `execFile` with argument arrays, never a
shell string, to run bounded read-only commands:

```text
git status --porcelain=v2 -z --untracked-files=all
git diff --no-ext-diff --no-textconv --binary=false
git diff --cached --no-ext-diff --no-textconv --binary=false
```

Do not set global/repository Git configuration. Detect non-Git directories
from the command result and return a typed fallback request. Cap stdout and
stderr independently and preserve a `truncated` flag.

### Commands and UI

Extend `CommandContext` with narrow typed operations rather than exposing the
journal object. Register `/changes`, `/diff`, `/undo`, and `/review` in
`src/commands/builtins.ts`; keep command bodies limited to validation,
formatting, and delegation.

`nativeApp.ts` wires these methods to the active `AgentSession`. Command errors
continue to use the existing single per-command `.catch(...)` boundary. The
two-step `/undo` flow uses notices and requires no new overlay state.

Print mode receives the same journal observer. A successful print-mode edit is
checkpointed before process exit. Slash commands remain interactive-only in
v1; adding CLI subcommands for changes/undo is out of scope.

## Implementation plan

### 1. Define mutation identity and observer contracts

1. Add the observer interfaces and optional `fileMutations` field to
   `ToolContext` in `src/engine/tools/types.ts`.
2. Add a shared path-resolution helper used by `Write` and `Edit`.
3. Wrap both tools with `before`/`after` capture while preserving their current
   return values and per-tool error behavior.
4. Add focused tests proving capture ordering, relative/absolute resolution,
   creation, overwrite, repeated edit behavior, and `after` execution on a
   failed/partial write path.

Files:

- Modify `src/engine/tools/types.ts`
- Add `src/engine/tools/filePath.ts`
- Modify `src/engine/tools/write.ts`
- Modify `src/engine/tools/edit.ts`
- Add `tests/engine-file-path.test.ts`
- Extend `tests/engine-file-tools.test.ts`

### 2. Implement durable checkpoint storage

1. Implement the typed `ChangeJournal` and content-addressed blob store.
2. Use temp-file-plus-rename atomic writes for manifests and restored files.
3. Coalesce repeated mutations within a checkpoint.
4. Implement storage limits, visible unavailable reasons, pruning, malformed
   manifest fallback, and project/session identity checks.
5. Implement text/binary detection and bounded unified diff generation.

Tests must cover modified and newly created files, multiple edits, exact byte
restoration, UTF-8 BOM content, binary files, large-file limits, deduplicated
blobs, malformed manifests, interrupted capture, Windows path case folding,
symlink/parent replacement, and retention boundaries.

Files:

- Add `src/agent/changeJournal.ts`
- Add `tests/changeJournal.test.ts`

If the production module approaches 600 lines, split storage primitives into
`src/agent/checkpointStore.ts` with its own `tests/checkpointStore.test.ts`;
do not allow one journal module to cross the project size limit.

### 3. Integrate checkpoints with `AgentSession`

1. Construct the journal after the session ID and cwd are known.
2. Pass it into the engine's native tools through `ToolContext` without adding
   persistence knowledge to `EngineLoop`.
3. Open/close checkpoints at the actual turn boundary, including interruption
   and errors.
4. Expose typed session methods for changes, diff, undo, and review input.
5. Ensure resume reloads checkpoint state and project switching cannot reuse a
   journal from the old cwd.

Tests must prove no-change turns create no checkpoint, a multi-tool turn creates
one checkpoint, interruption after an edit remains undoable, resume retains
undo state, and concurrent/queued input cannot overlap checkpoints.

Files:

- Modify `src/engine/loop.ts`
- Modify `src/agent/session.ts`
- Extend `tests/engine-loop.test.ts`
- Extend `tests/session.test.ts`
- Extend `tests/session-integration.test.ts`

### 4. Add `/changes`, `/diff`, and conflict-safe `/undo`

1. Add pure formatting helpers for summaries, diffs, previews, conflicts, and
   successful undo results.
2. Extend `CommandContext` and wire it in `nativeApp.ts`.
3. Register the three commands and their argument completion.
4. Refuse `/undo --yes` while a turn is active.
5. Apply undo as a preflighted operation: validate every target first, stage
   all restored bytes and current-state rollback copies in temporary siblings,
   then atomically replace/remove each target. If staging or validation fails,
   leave every target unchanged. If a later filesystem operation fails after
   an earlier target was restored, roll the earlier targets forward from the
   staged current-state copies and report both the original failure and any
   rollback failure; ordinary filesystems cannot guarantee a cross-file atomic
   commit.

Tests must cover command registration/usage, preview versus confirmation,
conflict and staging refusal with zero partial changes, mid-apply failure and
rollback, new-file deletion, external edits, missing targets, unavailable
large-file snapshots, output truncation, and the existing UI command error
boundary.

Files:

- Add `src/commands/changeFormatting.ts`
- Modify `src/commands/types.ts`
- Modify `src/commands/builtins.ts`
- Modify `src/ui/nativeApp.ts`
- Add `tests/changeFormatting.test.ts`
- Extend `tests/commands.test.ts`
- Extend `tests/app.test.ts`

### 5. Add bounded Git review

1. Implement Git worktree detection, status parsing, staged/unstaged diff
   collection, caps, and non-Git fallback.
2. Annotate the review request with journal-owned versus other paths.
3. Add `/review` and `/review --staged`; reject other arguments.
4. Send one generated review prompt through the normal session turn so provider
   selection, permissions, persistence, interrupt, cost, and error handling
   remain unchanged.

Tests must prove argument-array invocation, `--no-ext-diff`, `--no-textconv`,
staged selection, paths containing spaces/newlines, untracked-file reporting,
large diff truncation, Git-not-installed behavior, non-Git fallback, and prompt
separation of session-owned and external changes.

Files:

- Add `src/agent/gitReview.ts`
- Add `tests/gitReview.test.ts`
- Modify `src/commands/types.ts`
- Modify `src/commands/builtins.ts`
- Modify `src/ui/nativeApp.ts`
- Extend `tests/commands.test.ts`

### 6. Documentation, cleanup, and end-to-end verification

1. Document the four commands, automatic checkpoint location, limits, and the
   explicit statement that Bash/MCP changes are not undoable.
2. Add checkpoint storage to `cloudcode config` output so users can locate it.
3. Verify package contents do not accidentally include runtime checkpoint data.
4. Manually test in a dirty Git worktree containing pre-existing staged,
   unstaged, and untracked user files:
   - let cloudcode edit one already-dirty file and create one new file;
   - confirm `/changes` attributes only native edits;
   - confirm `/review` sees the complete Git state and labels ownership;
   - externally edit a cloudcode-modified file and confirm undo refuses all;
   - restore that external edit, run `/undo --yes`, and confirm the original
     dirty state returns byte-for-byte;
   - resume the session and confirm checkpoint history is still available.

Files:

- Modify `README.md`
- Modify `src/commands/cli/config.ts`
- Extend `tests/cliConfig.test.ts`
- Extend `tests/packaging.test.ts` only if packaging metadata changes

## Delivery sequence

Use focused commits in this order:

1. Engine mutation observer and native tool instrumentation.
2. Durable agent checkpoint journal and diff generation.
3. Session lifecycle integration.
4. `/changes`, `/diff`, and `/undo` command/UI wiring.
5. Read-only Git review and `/review`.
6. Documentation and final verification.

After each commit, run the focused tests named in that task. After all commits,
run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```

## Completion criteria

- Native `Write`/`Edit` changes from one user turn form one durable checkpoint.
- `/changes` never attributes pre-existing, Bash, MCP, or external mutations to
  the native checkpoint journal.
- `/undo` previews first and never overwrites a file whose after state changed.
- A multi-file conflict or staging failure produces zero partial restoration;
  a mid-apply filesystem failure attempts rollback and reports its exact final
  state instead of claiming atomicity.
- Undo restores the exact pre-turn bytes, including pre-existing user edits.
- Resume retains checkpoint and undo state for the same project/session.
- `/review` covers complete staged/unstaged Git changes without executing
  external diff drivers and clearly reports truncation.
- Non-Git projects retain `/changes`, `/diff`, and `/undo` functionality.
- Every new production module has a corresponding test module and remains below
  the repository's size ceiling.
- Lint, size checks, build, full tests, and high-severity audit all pass.
