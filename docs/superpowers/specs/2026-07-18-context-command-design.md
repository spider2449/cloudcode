# /context Command — Design

Date: 2026-07-18
Status: Approved (Approach A: snapshot the last request)

## Goal

Add a `/context` builtin command that shows a per-category breakdown of context
window usage, similar to Claude Code's `/context`: system prompt, tools, and
messages, plus total usage against the model's context window.

## Approach

Snapshot the last API request. Each time the engine builds a request in
`AgentLoop.streamOnce` (`src/engine/loop.ts`), record a small **context
snapshot** with character-based token estimates (chars / 4) for each request
component, then attach the real `input_tokens` (including cache read/create
tokens) from the response's `usage` once the stream completes.

`/context` reads the latest snapshot and prints a table. Per-category numbers
are scaled proportionally so they sum to the real API total when one is
available; the remainder up to the context window is shown as free space.

Before the first turn of a session (no snapshot yet), build the same estimate
on demand from the loop's current state (`systemPrompt`, `tools`, `messages`)
with no API total — labeled as an estimate.

## Components

### 1. `ContextSnapshot` (new, in `src/engine/loop.ts`)

```ts
interface ContextSnapshot {
  systemTokens: number;   // chars/4 of system prompt text
  toolsTokens: number;    // chars/4 of JSON.stringify(tools array)
  messagesTokens: number; // chars/4 of JSON.stringify(messages)
  inputTokens?: number;   // real usage: input_tokens + cache_read + cache_creation
}
```

- `AgentLoop` keeps `lastContextSnapshot: ContextSnapshot | undefined`.
- Estimates recorded when `req` is built in `streamOnce`; `inputTokens` filled
  from `usage` after the stream ends.
- Public method `contextSnapshot(): ContextSnapshot` — returns the last
  snapshot, or computes estimates on demand from current state if none exists.

### 2. `CommandContext.contextInfo()` (in `src/commands/types.ts` + `src/ui/nativeApp.ts`)

New method `contextInfo(): { snapshot: ContextSnapshot; model: string; contextWindow: number }`.
`nativeApp` already knows the context window per provider
(`contextWindowFor`, `src/ui/nativeApp.ts:147`).

### 3. `/context` command (in `src/commands/builtins.ts`)

Formats and prints via `ctx.notice`:

```
Context usage — claude-sonnet-5 (72.3k / 200k tokens, 36%)

  System prompt   4.1k   2.1%
  Tools          14.2k   7.1%
  Messages       53.5k  26.8%
  Free space    127.7k  63.9%
```

- Total line uses real `inputTokens` when available, otherwise the sum of
  estimates with an "(estimated)" suffix.
- When a real total exists, the three category estimates are scaled by
  `inputTokens / sum(estimates)` so rows sum to the header total.
- Token formatting reuses the status bar's `formatTokens` style (k-suffixed,
  one decimal).
- Memory/CLAUDE.md content is part of the system prompt in this codebase, so
  it is not a separate row (YAGNI; can be split later if the prompt assembly
  exposes it).

## Error handling

- No session / provider not ready: `/context` prints "No context yet — send a
  message first." only if even the on-demand estimate is unavailable.
- Division by zero (empty estimates) guarded; percentages clamped to [0, 100].

## Testing

Follow existing test conventions in the repo (add unit tests alongside any
existing loop/command tests):
- Snapshot recorded on request build and updated with real usage.
- Scaling math: categories sum to real total.
- Formatting: output stable for a fixed snapshot.
- On-demand estimate path when no turn has run.
