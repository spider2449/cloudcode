# Thinking Color + Block Dots Design

Date: 2026-07-15

## Problem

1. The streaming "thinking" preview is only distinguished from real assistant
   text by ANSI dim (SGR 2), which many terminals (including legacy conhost)
   render weakly or not at all — thinking and real messages look the same.
2. Message blocks (assistant replies, tool calls) aren't visually marked as
   discrete blocks, making the transcript harder to scan.

## Decision

- Add a `thinking` color to `Theme` (`src/ui/theme.ts`): `dark` → magenta,
  `light` → cyan, `mono` → gray. Applied to the thinking preview in addition
  to (not instead of) dim, so terminals with either capability show a cue.
- Prefix each block with a leading circle:
  - Assistant messages: `● ` in the theme's default text color.
  - Thinking preview: `○ ` (hollow) in `theme.thinking`.
  - Tool lines: `●` (was `⏺`) in `theme.accent`, unchanged otherwise.
  - User messages keep their existing `> ` prefix — out of scope.
- Wrapped continuation lines are indented two spaces so text aligns under the
  dot column.

## Implementation notes

- `src/ui/layout.ts`: `layoutItem`'s `"assistant"` and `"tool"` cases prepend
  the dot and indent continuations after `wrapText`.
- `src/ui/term/render.ts`: the thinking-tail block gets `○ ` prefix on its
  first line, `theme.thinking` color, indented continuations, dim kept.
- No changes to committed transcript format beyond the prefix/indent — no new
  DisplayItem fields needed.

## Testing

- Renderer/layout tests assert the dot glyph, color codes, and continuation
  indent for assistant, tool, and thinking blocks in at least two themes.
