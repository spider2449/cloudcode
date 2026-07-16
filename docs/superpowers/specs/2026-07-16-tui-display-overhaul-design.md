# TUI Display Overhaul — Design

Date: 2026-07-16
Scope: native TUI only (`src/ui/nativeApp.ts`, `src/ui/term/*`, `src/ui/widgets/*`,
`src/ui/layout.ts`, `src/ui/transcript.ts`, `src/ui/streamTail.ts`, `src/ui/input.ts`),
plus one small engine addition in `src/engine/loop.ts`. The legacy Ink UI
(`src/ui/App.tsx`) is untouched.

## Problem

1. **Layout math counts characters, not terminal columns.** `wrapText`,
   `visibleLength`, `truncate`, and `tailForHeight` use `.length`. CJK
   characters occupy 2 columns but count as 1, so any line containing Chinese
   is laid out up to 2x wider than the renderer believes. On legacy conhost —
   which ignores `DECAWM ?7l` — those over-width rows wrap, scroll the region,
   and corrupt the pinned footer. This is the root cause of the recurring
   layout corruption.
2. **Message display lacks structure** compared to Claude Code / opencode:
   no spacing between transcript items, tool *results* are never shown (only
   the tool-use label), truncation is a fixed 80 chars, wrapping is a hard
   mid-word character cut, and the Edit "diff" dumps the whole old block then
   the whole new block.
3. **Paste breaks on terminals without bracketed paste.** `KeyDecoder` only
   recognizes paste via `ESC[200~ … ESC[201~`. Windows Terminal emits those;
   legacy conhost windows (classic `cmd.exe` / `powershell.exe`) do not, so a
   multi-line paste is replayed as keystrokes and every `\r` submits a message.

## Design

### 1. Width foundation — `src/ui/width.ts` (new)

- `charWidth(codePoint: number): number` — returns 0 for combining marks and
  zero-width joiners/variation selectors, 2 for East Asian Wide/Fullwidth
  ranges (CJK ideographs, Hangul, Kana, fullwidth forms) and common emoji
  ranges, 1 otherwise. Control chars return 0.
- `stringWidth(s: string): number` — ANSI-aware (strips SGR sequences),
  iterates by code point, sums `charWidth`.
- All layout math switches to these: `wrapText` / `visibleLength`
  (`layout.ts`), `truncate` (`transcript.ts`), `tailForHeight`
  (`streamTail.ts`), input-box cursor/padding math (`widgets/inputBox.ts`),
  status-bar padding (`widgets/statusBar.ts`), and any other `.length`-based
  column arithmetic in the render path.
- No new dependencies; the table is a small in-house range list with unit
  tests (`tests/width.test.ts`) covering ASCII, CJK, emoji, combining marks,
  and ANSI-colored strings.

### 2. Word-boundary wrapping (`layout.ts`)

`wrapText` prefers breaking at spaces; a single word longer than the width is
hard-cut. CJK characters may break anywhere (correct for Chinese). Wrap
decisions use `charWidth`, never char counts. Existing behaviors kept:
embedded ANSI codes stay attached to their text; explicit `\n` starts a new
wrap unit; a row never exceeds the terminal width in *columns*.

### 3. Transcript item spacing (`layout.ts`)

Claude Code-style rhythm: one blank row is emitted before `user`,
`assistant`, and `welcome` items (except at the very top of the buffer).
`tool`, `diff`, `result`, `notice`, and `error` items stay tight so a tool
call, its diff, and its result read as one group. Implemented in
`Buffer.takeCommitRows` / `layoutItem` so committed scrollback and reprints
agree.

### 4. Tool result display

- Engine: after `runTool` resolves in `loop.ts`, emit a new engine message
  `{ type: "tool_result", tool_use_id, content, is_error }` via `onMessage`
  (in addition to pushing it into `messages` as today).
- Transcript: map it to a new `DisplayItem`
  `{ kind: "toolResult"; text: string; isError: boolean }` showing the first
  line of output (width-aware truncation to the terminal width), rendered as
  `  ⎿ <preview>` in muted color (error color when `is_error`). Multi-line
  outputs show the first line plus a `(+N lines)` suffix.
- `truncate` gains a width parameter; the fixed 80 default remains only for
  callers without a width.

### 5. Real line diffs (`transcript.ts`)

Replace the old-block/new-block dump in `diffLines` with an LCS-based line
diff: unchanged lines render as context (muted, capped to a few lines around
changes), removals `-` in `theme.removed`, additions `+` in `theme.success`.
The existing 20-row cap with `… (+N more)` stays.

### 6. Streaming tail (`streamTail.ts`)

`tailForHeight` computes rows-per-line with `stringWidth` so the live
preview region never under-counts CJK rows (which currently lets the footer
overflow and scroll during streaming).

### 7. Paste fallback without bracketed paste (`input.ts`)

In `KeyDecoder.feed`, after draining a chunk: if a **single stdin chunk**
produced 2+ keys and all of them are `printable`, `enter`, or `tab`, coalesce
them into one `{ t: "paste", text }` key (enter → `\n`, tab → `\t`).
Rationale: a human cannot produce multiple keys in one read; auto-repeat
delivers one char per chunk. Bracketed paste continues to take precedence
where supported. Escape sequences in a chunk disable coalescing for that
chunk. IME input is unaffected (StringDecoder already assembles multi-byte
chars; a single CJK char is one `printable` key).

## Error handling

- Unknown/unassigned code points default to width 1 (safe: over-estimating
  is harmless; under-estimating causes the conhost wrap bug).
- `tool_result` content that is not a string (structured content) is
  stringified before preview; empty output renders `⎿ (no output)`.
- Diff computation falls back to the current dump format if inputs are
  missing/non-string.

## Testing

- New `tests/width.test.ts`; extended `tests/markdown.test.ts` untouched.
- `tests/messageList.test.tsx` / layout tests: spacing rows, toolResult
  rendering, CJK wrap correctness (a 10-column wrap of 6 CJK chars yields 2
  rows of 3), word-boundary wrapping.
- `tests/streamTail.test.ts`: CJK row counting.
- New decoder tests: multi-line paste chunk coalesces to one paste key;
  single keystrokes and escape sequences do not coalesce.
- Manual verification on Windows Terminal **and** a legacy conhost window
  (`conhost.exe` / classic cmd), per the conhost quirks memory.

## Non-goals

- No changes to the legacy Ink UI.
- No grapheme-cluster segmentation beyond combining marks/ZWJ (full Unicode
  segmentation is out of scope; width-2 fallback for emoji is acceptable).
- No scrollback/paging changes.
