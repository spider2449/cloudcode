# Task 2 report: Thread AbortSignal into tool execution

## Changes

- `src/engine/tools/types.ts`: Added optional `signal?: AbortSignal` to `ToolContext`.
- `src/engine/loop.ts`:
  - `runTurn`'s tool-execution loop now short-circuits: once `signal.aborted` is true, each
    remaining `tool_use` block gets a synthesized `tool_result` (`"Interrupted by user"`,
    `is_error: true`) instead of being executed, and the loop `break`s out of the outer
    turn loop after pushing the results message — matching the API invariant that every
    `tool_use` id needs a `tool_result` in the following user message.
  - `runTool` gained a second `signal: AbortSignal` parameter and passes it through as
    `ctx.signal` to `tool.execute`.
- `src/engine/tools/bash.ts`: `execFile` now receives `signal: ctx.signal` in its options
  so an abort kills the child process immediately. The error-handling branch distinguishes
  an interrupt (checked first, via `ctx.signal?.aborted`) from a timeout (`killed` without
  an aborted signal) from a plain nonzero exit.
- `tests/engine-loop.test.ts`: Added "passes the abort signal to tools and skips remaining
  tools after abort" — a two-tool scripted turn where the first tool's `execute` captures
  `ctx.signal` and calls `controller.abort()` mid-execution; asserts the second tool never
  runs, but both `tool_use` ids still get `tool_result` entries, the second marked
  "Interrupted".
- `tests/engine-bash-tool.test.ts`: Added "kills the command and reports an interrupt when
  the signal aborts" — starts a 30s sleep, aborts after 200ms, asserts the promise resolves
  well under 10s with an error result containing "interrupted".

## TDD sequence and exact commands run

1. Wrote both new tests, ran them before implementing:
   - `npx vitest run tests/engine-loop.test.ts -t "abort signal"` → FAIL:
     `expected undefined to be AbortSignal {...}` (seenSignals[0] was undefined, since
     `runTool` didn't accept/pass a signal yet).
   - `npx vitest run tests/engine-bash-tool.test.ts -t "interrupt"` → FAIL: test timed out
     at 15000ms (execFile had no `signal` wired in, so the 30s sleep just kept running).
2. Implemented the three source changes (`types.ts`, `loop.ts`, `bash.ts`) per the brief.
3. Re-ran both full test files:
   - `npx vitest run tests/engine-bash-tool.test.ts tests/engine-loop.test.ts`
   - Result: `Test Files 2 passed (2)`, `Tests 18 passed (18)`.
4. Full project typecheck: `npx tsc --noEmit` → no output (clean).

## Concerns

- None. Implementation matches the brief's exact snippets; both new tests and all
  pre-existing tests in the two files pass. `ToolContext.signal` is optional so no other
  `ToolDef.execute` implementations needed changes.
- Did not run the entire repo-wide test suite (only the two changed files plus a
  typecheck), per the task's stated scope — these files are self-contained for this task.
