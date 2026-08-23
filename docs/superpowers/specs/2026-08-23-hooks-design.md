# Hooks System Design

Date: 2026-08-23

## Goal

Let users run local shell commands on agent lifecycle events. Six events are
supported: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, and `SessionEnd`. `PreToolUse` is enforcement: a failing hook blocks
the tool call. The other five are observational.

## Non-goals

- Hook output fed back into the model as context (v1 reports blocking stderr
  only).
- Per-tool or per-event matcher patterns (every registered hook runs for its
  event; filtering by tool name may come later).
- Hooks contributed by packs.
- Parallel hook execution.

## Configuration

Two layers, merged per event (user entries first, then project entries):

- **User:** `~/.cloudcode/hooks.json` — trusted by definition (the user wrote
  it on their own machine).
- **Project:** `.cloudcode/hooks.json` — executable project configuration, so
  it uses the same content-digest trust boundary as MCP/LSP/task profiles: the
  file's SHA-256 digest must be approved in the `ProjectTrustStore`. An
  untrusted project file is ignored entirely and the session shows a one-line
  notice ("project hooks are not trusted; approve them to enable") instead of
  silently dropping it.

Shape:

```json
{
  "hooks": {
    "PreToolUse": [{ "command": "node scripts/guard.js", "timeoutMs": 10000 }],
    "PostToolUse": [{ "command": "notify.sh" }]
  }
}
```

Validation: unknown event keys, non-string commands, non-positive timeouts,
and non-object entries are skipped with a warning; valid entries survive.

## Components and placement

Following AGENTS.md layering — config and process execution live in
`agent/`, the engine receives behavior through an injected interface:

- **`src/agent/hooks.ts`**
  - `HookEvent` — `"SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd"`.
  - `loadHooksConfig(cwd, base)` → `{ hooks: Partial<Record<HookEvent, HookEntry[]>>, warnings: string[], projectTrusted: boolean }`, merging both layers with validation as above.
  - `class HooksRunner` — constructor takes the loaded config plus an injected
    executor `(command, args, options) => Promise<ExecResult>` defaulting to
    `execFile` via the same shell selection as `tools/bash.ts`
    (PowerShell on Windows, sh elsewhere). Method:
    `run(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome>` where
    `HookOutcome = { blocked: boolean; notices: string[] }`.
- **Engine injection** — `EngineOptions.hooks?`:
  ```ts
  hooks?: {
    /** Runs PreToolUse before execution; blocked=true rejects the call. */
    guard(toolName: string, input: Record<string, unknown>): Promise<{ blocked: boolean; reason?: string }>;
    /** Fire-and-forget observation; never rejects. */
    observe(event: "PostToolUse" | "Stop", payload: Record<string, unknown>): Promise<void>;
  };
  ```
  Structural interface, same precedent as `fileMutations`/`networkPolicy` —
  engine code never reads hook files or spawns processes itself.
- **`src/agent/session.ts`** — loads the config, builds the `HooksRunner`,
  implements the injected interface over it, passes it into `EngineLoop`, and
  fires `SessionStart`/`SessionEnd`/`UserPromptSubmit` at the session layer
  (these three have no engine dependency). Untrusted-project notices and
  config warnings surface through the existing `onMessage(errorResult(...))`
  channel at startup.

## Execution semantics

Each hook command:

1. Spawned with the event JSON on **stdin** (`{ event, ...payload }`) and
   `CLOUDCODE_HOOK_EVENT` in the environment; cwd is the session's project
   directory.
2. Killed after `timeoutMs` (default 10000).
3. Exit code 0 = success. Any failure (non-zero exit, spawn error, timeout)
   is isolated to that entry and recorded as a notice.

Per event:

| Event | Failure semantics |
|---|---|
| `PreToolUse` | **Fail-closed**: non-zero exit, spawn error, or timeout blocks the tool call; stderr becomes the block reason shown to the model |
| all others | failure logged as a notice; agent continues |

## Engine integration points

- `runTool`: after permission approval, `await hooks.guard(name, input)` —
  if blocked, return the existing denied-style error tool_result with
  `Blocked by PreToolUse hook: <reason>`; otherwise execute, then
  `await hooks.observe("PostToolUse", { tool: name, isError })` — awaiting is
  safe because every entry's runtime is already capped by its `timeoutMs`.
- Turn end (`send` completion): `observe("Stop", {})`.
- Session layer: `SessionStart` before the first turn is possible,
  `UserPromptSubmit` with `{ promptLength }` when the user submits text,
  `SessionEnd` on dispose.

## Error handling

The runner catches everything internally; no new try/catch at integration
points. A crashing hook can never crash the session — worst case is a blocked
tool call or a dropped notice, matching the per-tool/per-turn boundary
philosophy.

## Testing

- **Config**: two-layer merge order; invalid-entry skipping with warnings;
  untrusted project digest ignored + notice; trusted digest included.
- **Runner**: injects a fake executor — success, non-zero exit, timeout kill,
  spawn error; asserts fail-closed only for PreToolUse; asserts stdin payload
  shape.
- **Loop integration**: PreToolUse block produces an error tool_result and the
  turn continues; PostToolUse/Stop observed with expected payloads.
- **Session**: untrusted project hooks produce exactly one startup notice.
