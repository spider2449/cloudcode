# Background Bash Design

Date: 2026-08-23

## Goal

Let the model start long-running shell processes (dev servers, watchers, test
suites) in the background and read their output later, instead of blocking the
turn until a timeout.

## Non-goals

- Background shells surviving resume (they are in-memory; a resumed session is
  a new environment).
- Interactive stdin to background processes.
- Background execution for anything other than the Bash tool.

## Tool suite

### Bash (extended)

`run_in_background?: boolean` joins the input schema. When true:

- The command is spawned via `child_process.spawn` with the same shell
  selection as the foreground path (PowerShell on Windows, sh elsewhere).
- The call returns immediately:
  `Shell started in background (id: b3). Use BashOutput to read its output.`
- Foreground behavior is completely unchanged when the flag is absent/false.

### BashOutput (new)

Input: `{ id: string }`. Returns the output accumulated since the last read
plus current status (`running` or `exited N`). Unknown id → error result.
Reading marks the returned bytes consumed.

### KillShell (new)

Input: `{ id: string }`. Sends SIGTERM (TerminateProcess-equivalent via
`child.kill()`), waits briefly, then SIGKILL. Returns any remaining output and
the exit status. Frees the slot.

## Limits

- Maximum **10** concurrent background shells per session. A start beyond the
  cap fails with an error telling the model to kill one first.
- Output buffer: **200 KB** ring per shell; overflow drops the oldest bytes and
  prepends `[earlier output dropped]` on the next read.

## Components and placement

All engine-side, following where `bash.ts` already lives:

- **`src/engine/tools/backgroundShells.ts`**
  - `interface BgShell { id: string; running(): boolean; exitCode?: number; readNew(): string; kill(): Promise<string>; allOutput(): string }`
  - `class BackgroundShellManager` — constructor takes an injectable spawner
    `(command: string, cwd: string) => ChildLike` where `ChildLike` mirrors the
    subset of `ChildProcess` used (`pid?`, `stdout`, `stderr` readable streams,
    `kill()`, exit event). Defaults to real `spawn`. Methods:
    `start(command, cwd): { id } | { error }`, `read(id): string`,
    `kill(id): Promise<string>`, `count()`, `killAll(): void`.
  - Ring-buffer implementation shared by stdout/stderr merges.
- **`src/engine/tools/bash.ts`** — `Bash.execute` consults an optional
  `backgroundShells?: BackgroundShellManager` passed through `ToolContext`
  (structural field like `networkPolicy`); when `run_in_background` is true it
  delegates to the manager.
- **`src/engine/tools/bashOut.ts`** — `createBashOutputTool(mgr)` /
  `createKillShellTool(mgr)` thin tool wrappers.
- **`src/engine/registry.ts`** — `builtinTools(options)` gains
  `bgShells?: BackgroundShellManager`; registers `BashOutput`/`KillShell` only
  when provided.
- **`src/engine/loop.ts`** — `EngineOptions.bgShells?` plumbed into the
  ToolContext so Bash can reach the manager.
- **`src/agent/session.ts`** — creates one manager per session, passes it into
  `builtinTools` and `EngineLoop`, and calls `killAll()` in `dispose()`.

## Permissions

- Backgrounded commands go through the exact same `decidePermission("Bash", …)`
  flow as foreground ones — same prompt, same remembered rules.
- `BashOutput` / `KillShell` only touch state from an already-approved command:
  auto-allowed unconditionally (same treatment as TodoWrite).

## Lifecycle

- Shells live until killed or session dispose (`killAll()`), surviving turn
  interrupts deliberately.
- Not persisted: resume starts with zero background shells.

## Error handling

Spawn failures at start time return an error tool_result immediately. Stream
errors are captured as output text. Nothing in the manager throws across its
public surface except invalid usage, which tools translate into `is_error`
results via the existing per-tool boundary.

## Testing

Inject a fake spawner returning scriptable child objects:

- Start returns sequential ids; cap rejects the 11th with guidance.
- Output accumulates across writes; incremental reads return only new data;
  ring overflow drops oldest with the drop marker.
- Kill terminates, reports remaining output, frees the slot.
- Exit code appears in status after the exit event fires.
- Session wiring: dispose calls killAll (spy on the manager).
