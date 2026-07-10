# cloudcode v2 Polish — Close the UX Gap with Real Claude Code: Design

Date: 2026-07-10
Status: Approved
Builds on: `2026-07-10-cloudcode-design.md` (v1, implemented on master)

## Goal

Make cloudcode feel like real Claude Code in four areas: token-by-token streaming
output, markdown + syntax-highlighted rendering, a working-state spinner, and an
upgraded input box (cursor movement, history, multi-line).

## Approach

Targeted upgrades with small mature libraries (chosen over adopting a full component
suite or hand-rolling): SDK `includePartialMessages` for streaming, `marked` +
`marked-terminal` for markdown/highlighting, `ink-spinner` for the spinner,
`ink-text-input` for the input field.

## 1. Token Streaming

- `AgentSession` passes `includePartialMessages: true` to `query()`. The SDK then
  emits `stream_event` messages carrying content deltas.
- New `DisplayItem` kind: `{ kind: "streaming"; text: string }`.
- `toDisplayItems` maps text deltas from `stream_event` messages to incremental
  updates: App appends to (or creates) a trailing `streaming` item.
- When the complete assistant message arrives, the trailing `streaming` item is
  replaced by the final `assistant` item(s) (which go through markdown rendering).
  Tool-use chips render as today from the final message.
- On interrupt (Esc), whatever partial text is displayed stays in the transcript.
- Streaming text renders as plain text (no markdown parsing of incomplete input).

## 2. Markdown + Syntax Highlighting

- Finalized assistant text is converted to an ANSI string via `marked` +
  `marked-terminal` (bold, lists, headings, colored code blocks via its built-in
  cli-highlight). Ink `<Text>` renders the ANSI string directly.
- Conversion lives in `src/ui/markdown.ts`: `renderMarkdown(text: string): string`,
  with a fallback: on any parse error return the raw text.
- Edit/Write tool chips gain a colored diff/preview block below the chip: green `+`
  and red `-` lines, computed from the tool input (`old_string`/`new_string` for
  Edit; first lines of `content` for Write), capped at 20 lines with a `… (+N more)`
  tail.
- New `DisplayItem` kind: `{ kind: "diff"; lines: Array<{ sign: "+" | "-" | " ";
  text: string }> }` emitted right after the corresponding `tool` item.

## 3. Spinner / Working State

- While phase is `streaming`, a status line renders above the input box:
  `⠋ Thinking… (12s · Esc to interrupt)`.
- When the most recent SDK activity is a `tool_use`, the label switches to
  `⠋ Running <ToolName>… (3s)` until the next assistant text or result.
- Implementation: `ink-spinner` + a 1-second interval tick for elapsed time,
  started when phase enters `streaming`, cleared on `result`.
- Component: `src/ui/WorkingIndicator.tsx` with props
  `{ label: string; startedAt: number }`.

## 4. Input Box Upgrade

- Replace the hand-rolled character handling in `InputBox` with `ink-text-input`
  (cursor movement, Home/End, paste handled by the library). Our wrapper keeps:
  slash-completion hints, Tab completion, disabled state.
- Command history: Up/Down cycles through past inputs. Persisted to
  `~/.cloudcode/history.json` (most recent 100 entries), loaded at startup, shared
  across sessions. Module: `src/agent/history.ts` with
  `class History { constructor(filePath?); add(text): void; back(): string | undefined;
  forward(): string | undefined; resetCursor(): void }`.
- Multi-line input: a line ending in `\` + Enter inserts a newline instead of
  submitting; the submitted text joins the lines with `\n`.

## Error Handling

- Markdown rendering failures fall back to raw text (never crash the transcript).
- History file corrupt/missing → start with empty history (same tolerant-load
  pattern as providers.json / sessions.json).
- Streaming with providers that don't send partial events (some llama.cpp builds)
  degrades gracefully: no `stream_event`s simply means output appears when the full
  message arrives, as in v1.

## Testing

- transcript: unit tests for delta accumulation and final-message replacement;
  diff-item generation for Edit/Write inputs (cap + ellipsis).
- markdown: `renderMarkdown` returns ANSI containing expected fragments for bold /
  code block; falls back to raw text on parse error.
- history: add/back/forward/reset + persistence across instances + 100-entry cap.
- InputBox: existing ink-testing-library patterns; multi-line continuation test;
  history recall test.
- WorkingIndicator: renders label and elapsed seconds.

## Out of Scope (YAGNI)

- Themes/configurable colors, image display, telemetry, @-file completion,
  markdown rendering of streaming (pre-final) text.
