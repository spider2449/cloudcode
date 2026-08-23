# Todo Tracking Tool Design

Date: 2026-08-23

## Goal

Give the model a `TodoWrite` tool that maintains a structured task checklist
during long multi-step work, render the live list in the TUI so the user can
see progress, and persist the latest snapshot with the session so it survives
resume.

## Non-goals

- Todo deletion history / audit trail (the list is replace-only).
- Cross-session or cross-project todo persistence (dies with the session file,
  like the transcript itself).
- Subagent access: the Task subagent's read-only toolset does not include it.
- A separate `/todo` slash command (YAGNI until requested).

## Tool behavior

Tool name: `TodoWrite`, registered in `builtinTools()` for all sessions
(interactive and print).

Input schema — full-list replacement, never incremental patches:

```json
{
  "todos": [
    { "content": "Reproduce the timeout", "status": "completed" },
    { "content": "Patch retry logic", "status": "in_progress" },
    { "content": "Add regression test", "status": "pending" }
  ]
}
```

Validation (failures become an `is_error` tool result via the existing
per-tool boundary):

- `todos` must be an array of at most **50** entries.
- Each entry needs non-empty string `content` and a `status` of exactly
  `"pending" | "in_progress" | "completed"`.
- At most one entry may be `in_progress`.
- Duplicate `content` values are rejected.

Success output: a one-line confirmation with counts, e.g. `3 todos (1 in progress, 1 done)`.

Permissions: the tool touches only internal session state — auto-allowed like
read-only tools, no prompt, not storeable as a rule.

## State flow

1. `TodoWrite.execute` validates, stores the snapshot in a small engine-side
   store, and emits a broadcast message through the existing `onMessage`
   channel:
   ```ts
   { type: "todos", todos: Array<{ content: string; status: TodoStatus }> }
   ```
2. This message is **UI-broadcast only**: it is never pushed into
   `EngineLoop.messages` (the API conversation), so it costs zero context.
3. The TUI transcript renders a `todos` message as a checkbox block:
   `►` in_progress, `☐` pending, `☑` completed. Each update renders a fresh
   block; earlier blocks simply scroll away with the rest of the history.
4. Persistence: when the session file is appended after each turn, the latest
   snapshot rides along as an additive record (`{"type":"todos",...}`) in the
   session JSONL; on resume the last record is replayed as a `todos` message
   so the UI restores the list. Session-file consumers that ignore unknown
   record types are unaffected (additive-schema rule from print events).

## Components and placement

Following AGENTS.md layering:

- **`src/engine/tools/todo.ts`** — tool + validation + a module-level
  `parseTodos(value): { todos?: TodoItem[]; error?: string }` helper exported
  for reuse by resume replay.
- **`src/engine/messages.ts`** — extend the `EngineMessage` union with the
  `todos` variant and export a `todosMessage(todos)` factory.
- **`src/engine/loop.ts`** — no changes to the turn loop itself beyond wiring:
  the tool receives an emitter through its own closure (created by registry),
  keeping the loop untouched.
- **`src/engine/sessions.ts`** — `SessionFile.append` gains an optional
  todos-record write path plus a read path that surfaces the final snapshot;
  additive to the existing format.
- **`src/ui/transcript.ts`** — renderer branch for the `todos` message.
- **`src/agent/session.ts`** — on resume, replay the stored snapshot through
  `onMessage` after the init system message.

Registry: `todoTool` joins the static builtin list (no deps needed); the tool
writes state through a tiny store object created per-loop instance and handed
to it via `builtinTools({ todoStore? })` — undefined means "stateless mode"
where validation still runs and broadcasts go nowhere (used by tests and any
future caller that opts out). Interactive sessions always pass a real store.

## Error handling

Entirely within the existing boundaries: validation failures return
`{ isError: true }`; the store cannot fail (plain in-memory array); session
persistence failures surface through the same catch that already guards
session saving.

## Testing

- **Validation**: empty content, bad status, >1 in_progress, duplicates,
  >50 entries, valid minimal list.
- **Broadcast**: a `TodoWrite` call during a scripted turn emits exactly one
  `todos` message with the full snapshot, and `loop.messages` stays free of it.
- **Persistence**: append writes the additive record; loading a session with a
  trailing todos record replays it; records without todos load unchanged.
- **Rendering**: the three statuses map to their glyphs; unknown statuses
  render as pending rather than throwing.
