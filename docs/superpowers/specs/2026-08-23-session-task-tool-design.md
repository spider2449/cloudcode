# Session Task Tool (In-Session Subagent) Design

Date: 2026-08-23

## Goal

Let the model dispatch a read-only exploration subagent during an interactive
turn via a native `Task` tool. The subagent runs in its own context window with
a restricted toolset, so broad codebase exploration does not flood the main
conversation's context.

## Non-goals

- Writable subagents (Write/Edit/Bash) — may come later.
- Parallel/background subagents — the call is synchronous; the interface may
  later gain a background option without breaking this one.
- WebFetch or MCP tools inside the subagent — v1 is local-only exploration.
- A new provider contract — the subagent reuses the same `EngineLoop`.

## Components and placement

Following AGENTS.md layering (all engine-side):

- **`src/engine/tools/task.ts`** — exports `createTaskTool(deps)` rather than a
  static tool object: the tool needs the parent session's provider client,
  permission store, and permission prompt callback, none of which are available
  through `ToolContext`. Dependencies are passed as getters where they can
  change mid-session so the subagent always reflects current state:

  ```ts
  export interface TaskToolDeps {
    client(): MessagesClient;
    model(): string;
    effort(): EffortLevel;
    contextWindow?(): number;
    permissionMode(): PermissionMode;
    store: PermissionStore;
    lsp?: LspManager;
    networkPolicy?: NetworkPolicy;
    requestPermission(
      toolName: string,
      input: Record<string, unknown>
    ): Promise<boolean>;
  }
  ```

- **`src/engine/registry.ts`** — `builtinTools()` accepts an optional
  `task?: TaskToolDeps`. The `Task` tool is registered only when deps are
  provided; print mode and any other caller that omits them simply never see
  the tool.
- **`src/agent/session.ts`** — builds the deps from its existing fields and
  passes them to `builtinTools()`.
- **`src/engine/systemPrompt.ts`** — adds a compact explorer system prompt:
  you are a code-exploration subagent, use read/search tools, report findings
  concisely, do not attempt changes.

## Subagent toolset

Exactly: `Read`, `Glob`, `Grep`, and the five read-only LSP tools
(`definition`, `references`, `hover`, `symbols`, `diagnostics`) — the same
"native read/search + read-only LSP" set the CLI worker verify/review roles
use. `Task` itself is absent, which makes recursion structurally impossible.

## Tool behavior

Input schema:

```json
{ "description": "find auth token handling", "prompt": "..." }
```

`description` is a 3-5 word summary for the user-facing transcript line;
`prompt` is the full instruction. Both required.

Execution:

1. Builds a fresh `EngineLoop` with: the deps' client/model/effort/context
   window, the restricted toolset above, the explorer system prompt, the same
   `cwd`, `permissionMode()`, `store`, `lsp`, `networkPolicy`, and
   `requestPermission` callback as the parent (so permission overlays queue
   exactly as they do for parent-turn calls), and a no-op `onMessage`.
2. Runs `runTurn(prompt, ctx.signal)` — user interrupts abort the subagent
   directly.
3. Returns the text of the subagent's final assistant message. If the loop
   stopped because it hit its turn limit, the result is prefixed with a note
   that the exploration was cut off.

Turn limit: the subagent gets a smaller cap than the main loop's 100 — 30
turns. `EngineOptions` gains an optional `maxTurns` field defaulting to the
current constant, which the task tool sets to 30.

## Permission and safety model

- The parent's own `Task` call goes through the standard
  `decidePermission` flow: "ask" by default (plain Yes/No — no path/host rule
  scope), auto-allowed under `bypassPermissions`.
- Inside the subagent, decisions reuse the same mode/store/callback: read-only
  local tools are allowed by default; reads outside cwd still prompt through
  the normal overlay queue.
- No new network capability is exercised: the subagent's toolset performs no
  outbound requests beyond the provider call itself.

## Error handling

Relies on the three existing boundaries, no new try/catch:

1. Per-tool inside the subagent (`runTool`) — a failing read/LSP call becomes
   an error tool_result and the subagent continues.
2. Per-turn (nested `send`) — a provider/stream failure becomes an error
   message in the subagent's transcript. The tool's `onMessage` callback
   captures the subagent's `EngineMessage`s (used both for the final-text
   extraction and failure detection): if the last captured message is an
   error result, the task tool returns `{ isError: true }` with that message
   to the parent.
3. Per-command — unchanged.

The parent turn survives any subagent failure.

## Testing

Reuses the mock `client(turns)` pattern from `tests/engine-loop.test.ts`:

- **Final-text extraction** — multi-block assistant messages collapse to their
  text content.
- **Toolset restriction** — the nested loop receives exactly the eight
  read-only tools (Read, Glob, Grep + five LSP) and no `Task`.
- **Turn-limit truncation** — a client that always demands another tool call
  produces the cut-off note after 30 turns.
- **Permission propagation** — a denied request inside the subagent yields an
  error tool_result there while the parent result stays non-error; a denied
  parent-level `Task` call never executes.
- **Interruption** — aborting `ctx.signal` stops the nested turn.
- **Integration** — against a temp directory, a scripted client that greps a
  file returns the expected finding text.
