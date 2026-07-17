# Queued Input While Streaming — Design

Date: 2026-07-17
Status: Approved (pending spec review)

## Problem

While the agent is working (`phase === "streaming"`), the native TUI drops all
input: `App.handleKey` passes `disabled=true` into `InputBox.handleKey` /
`handlePaste`, and `App.handleSubmit` returns early. The user cannot type or
queue a follow-up message until the turn finishes. Claude Code allows typing
during a turn and queues submitted messages for delivery when the agent goes
idle; this project should behave the same way.

## Goals

- Typing, editing, paste, history navigation, and completions work while the
  agent is streaming.
- Pressing Enter while streaming queues the message instead of dropping it.
- Queued messages are visible in the UI above the input box.
- Queued messages are sent automatically, in order, one per turn, when the
  agent becomes idle.
- Esc still interrupts the current turn; the queue survives an interrupt.

## Non-Goals

- Esc-to-unqueue (popping the last queued message back into the input box).
  Deferred as YAGNI.
- Mid-turn steering (sending text into the running session immediately).

## Design

### 1. Input box stays live during streaming

In `App.handleKey` and the paste branch (`src/ui/nativeApp.ts`), stop passing
`this.phase === "streaming"` as the `disabled` argument to
`InputBox.handleKey` / `handlePaste`; pass `false`. Likewise pass
`disabled=false` to `InputBox.render` in `recompute`, so the cursor block is
visible and suggestions/menus work mid-turn.

The "working… (Esc to interrupt)" hint row currently rides on the `disabled`
flag inside `InputBox.render`. Decouple it: the hint is shown whenever the app
is streaming, independent of input being enabled. This becomes an explicit
`streaming: boolean` (or similar) input to `InputBox.render` rather than
overloading `disabled`.

### 2. Enter queues

`App.handleSubmit` while `phase === "streaming"` pushes the raw text onto a
new `queuedMessages: string[]` field on `App` (instead of returning early) and
lets the input box clear as it does on a normal submit. Slash commands are NOT
parsed at queue time; the raw text is stored.

Queued messages render as dim rows immediately above the input box in the
bottom region assembled in `recompute`, one row per message, e.g.:

```
⧉ queued: fix the failing test too
```

Rows are truncated to terminal width (never emit over-width rows — conhost
constraint).

### 3. Auto-send on idle

At the point where the result message sets `this.phase = "idle"`
(`handleMessage` in `src/ui/nativeApp.ts`), if `queuedMessages` is non-empty,
shift the first item and run it through the normal `handleSubmit` path. This
means slash commands typed while busy execute in order when dequeued, and a
dequeued plain message starts a new turn (`phase` back to `"streaming"`),
which naturally drains the queue one message per completed turn.

### 4. Interrupt behavior

Esc during streaming still calls `session.interrupt()` unchanged. When the
interrupted turn produces its result and phase returns to idle, the queue
drains via the same path as (3). Errors that return the app to idle also drain
the queue the same way.

## Testing

Unit tests using the existing `submitForTest` helper:

- Submitting while `phase === "streaming"` queues instead of sending, and the
  queued row appears in the rendered bottom region.
- Multiple queued messages drain in FIFO order, one per turn completion.
- A queued slash command executes when dequeued.
- Typing keys while streaming mutates the input box content (no longer
  dropped).
