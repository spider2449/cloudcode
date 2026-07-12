# Hand-Rolled Alt-Screen TUI with Pinned Footer

Date: 2026-07-12
Status: Draft

## Goal

Replace the Ink + `<Static>` UI layer (`src/ui/*`) with a hand-rolled renderer that runs in the terminal's alternate screen buffer. The StatusBar is permanently pinned to the terminal's bottom row and is never scrolled away — not by the mouse wheel, not by hotkeys. The history the user reads lives in an in-app scrollback buffer the renderer owns; reading older output uses in-app `PgUp`/`PgDn`/`Home`/`End` (the `less`/`vim`/`htop` model), since the host terminal's scrollback is unavailable in alt-screen mode.

The agent engine, commands, sessions, providers, MCP, skills, and all 44 non-UI test files are untouched. The `EngineMessage` → `DisplayItem` mapping in `src/ui/transcript.ts` is reused verbatim.

## Motivation

The current UI is built on Ink's `<Static>`, which writes each completed transcript item once into the *host terminal's* scrollback as plain text, while Ink repaints the dynamic live region (InputBox + StatusBar) frame by frame. A `fillerHeight` box pushes the StatusBar toward the bottom *of the current frame*, but as soon as the user scrolls the mouse wheel up to read older output, the StatusBar scrolls away with the scrollback — it is not pinned to the viewport. A true pinned footer is impossible within the `<Static>`-append-to-host-scrollback model: once bytes are in host scrollback they are outside the application's control.

A previous fix (`b296cbb`) pinned the StatusBar to the bottom row *in steady-state idle frames*, but that only delays the unpinning — the footer still leaves the viewport as soon as the user scrolls. This rewrite removes that limitation by abandoning `Ink` and `<Static>` entirely and painting every frame directly from an app-owned buffer. Because every frame is a full repaint and the StatusBar is always painted at exactly `stdout.rows`, nothing can scroll it.

## Decisions

- **Abandon Ink, hand-roll rendering.** Replace `Ink`, `<Static>`, `useInput`, `ink-testing-library`, React, `ink-spinner`, `@types/react`, `react-devtools-core`, and `@types/marked-terminal`. Keep `marked` and `marked-terminal` — `src/ui/markdown.ts` continues to produce ANSI-styled strings as today.
- **Alternate screen buffer, full repaint per frame.** Enter alt screen with `\x1b[?1049h` at startup, leave with `\x1b[?1049l` at exit. Each render pass issues `\x1b[H` (cursor home) + `\x1b[2J` (clear) followed by a positional write of every visible row. The StatusBar is always the last row written, at `stdout.rows`. A diff-based incremental repaint was considered and rejected: ~2× the implementation complexity for negligible gain at this app's actual frame rate, and full-region updates (opening an overlay, completing a turn) defeat the diff in the common interactive cases anyway.
- **In-app scrollback, host mouse-wheel scroll disabled in-app.** Accept the standard alt-screen tradeoff: users navigate history via in-app `PgUp`/`PgDn`/`Home`/`End`/`Ctrl-B`/`Ctrl-F`, not the host terminal's wheel. On exit, alt-screen restoration returns the user to their pre-app scrollback unchanged.
- **Bracketed paste.** Opt into bracketed-paste mode (`\x1b[?2004h` at startup, off at exit) so a paste arrives as one logical event with its payload, not as a stream of keystrokes.
- **No `<Static>` filler math.** `fillerHeight`, `liveRegionFloor`, `resizeSafeFillerHeight`, `inputBoxRows`, `liveFloor`, `dynamicRows`, the 1-row safety reserve, and the resize one-frame lag are all deleted. The renderer owns every height and computes each frame's layout synchronously — there is no `measureElement` lag to defend against.
- **UI-only rewrite.** `src/agent/`, `src/engine/`, `src/commands/`, `src/version.ts`, and the 44 non-UI test files are untouched. The only non-UI-file change is removing the `render(<App/>)` call in `src/cli.tsx` and replacing it with `new App(...).run()`.
- **Rebuild UI tests from scratch.** Replace every `*.test.tsx` UI test file under `tests/` with `*.test.ts` files targeting the new pure-function / class APIs (see Testing). The one known pre-existing failure (`tests/skills.test.ts`, unrelated `loadSkills` environment issue) persists through the rewrite untouched.
- **Features preserved verbatim** (ported, not redesigned): all current slash commands, permission modes (`default`/`acceptEdits`/`bypassPermissions`) and Shift+Tab cycling, the suggestion menu and `@`/`/` completion, file-index refresh on `@` token, history recall (Up/Down arrows), backslash-continuation multi-line input, the working indicator and its label, compaction progress bar, auto-compact at ≥80% context, cost/tokens/context-percent tracking, the StatusBar's segment layout, `/clear`, `/compact`, `/resume` (and the resume picker), `/set project` (and the project picker), the permission dialog and its hotkeys and "Always/Never for this directory" memory, themes, mouse scrolling harmlessly being unavailable in alt-screen.

## Architecture

The rewrite is confined to `src/ui/` (plus a ~10-line `src/cli.tsx` change). Four layers, each a separate file or directory, each testable in isolation:

```
src/ui/
├── term/
│   ├── ansi.ts        Escape sequences (alt screen on/off, clear, cursor
│   │                  home, cursor hide/show, SGR color from name).
│   │                  Pure functions, no side effects.
│   ├── terminal.ts    Owns process.stdin (raw mode) + process.stdout
│   │                  (size + resize listener). Single instance. The only
│   │                  code that touches the TTY. Exposes cleanup() for exit.
│   └── render.ts      Pure: (Buffer, scrollOffset, BottomState, theme, size)
│                      => string. Builds one full-frame ANSI string. The
│                      heart of the renderer; assertable on its string return.
├── buffer.ts          Scrollback: append-only store of DisplayItems with a
│                      cumulative-rows index for fast seeking. Re-wraps only
│                      the visible window per frame (O(region height)).
├── layout.ts          Pure: string wrapping at width N (the wrap math moved
│                      here from bottomFill.ts), stripAnsi, layoutItem()
│                      returning styled row strings per DisplayItem kind.
├── widgets/
│   ├── statusBar.ts   Pure: (StatusBarProps, theme, width) => string. One row.
│   ├── inputBox.ts    Stateful: cursor + value + history + suggestion menu.
│   │                  handleKey(Key) / handlePaste(text) / render(theme, width)
│   │                  => InputBoxRender. Port of InputBox.tsx minus React.
│   ├── menu.ts        Pure: renderMenu(...) => string[], up to MAX_ROWS=8.
│   ├── overlay.ts     Stateful: one of resume/project/permission overlay;
│   │                  open*/handleKey/render. Ports the three pickers/dialog.
│   ├── workInd.ts     Pure: renderWorkInd(frame, label, elapsed, theme) => string.
│   └── progress.ts    Pure: renderProgress(label, pct, theme, width) => string.
├── input.ts          Streaming KeyDecoder. feed(chunk: Buffer) => Key[]; a
│                     state machine that recognizes arrow keys, Home/End,
│                     PgUp/PgDn, Tab/BackTab, bracketed paste, Ctrl-/Alt-
│                     modified keys, with a 25ms Escape-vs-Alt disambiguation.
├── App.ts           Orchestrator (no React): owns Buffer, scrollOffset,
│                    BottomState, the AgentSession, the InputBox/Overlay
│                    widget instances; routes EngineMessage events and
│                    decoded Keys; computes BottomState; calls render() and
│                    writes the frame. Same role as today's App.tsx.
├── transcript.ts    (kept verbatim) DisplayItem type, toDisplayItems,
│                    streamDelta, toolLabel.
├── markdown.ts      (kept verbatim) renderMarkdown.
├── theme.ts         (kept verbatim) THEMES, loadThemeName, saveThemeName.
├── streamTail.ts    (kept verbatim) tailForHeight (used by render() to cap
│                    the streaming preview).
└── useGitStatus.ts  Logic kept; React wrapper removed. The git-status hook
                     becomes a plain function the App calls on turnCount.
```

`src/cli.tsx` becomes `src/cli.ts` (no JSX) and constructs `new Terminal(); new App({ ... }).run()` instead of `render(<App/>)`.

## Data Flow

Two event sources feed `App`:

1. **stdin bytes** — `Terminal` listens for `'data'` on `process.stdin` (raw mode) and forwards each chunk to `KeyDecoder.feed()`, which returns a list of decoded `Key`s. Each `Key` is passed to `App.handleKey(Key)` synchronously.
2. **`EngineMessage` via `AgentSession.onMessage`** — passed to `App.handleMessage(msg)`.
3. A 1-second timer drives `App.tick()` to advance the WorkingIndicator spinner and elapsed-time displays.

On any event, `App.recompute()` rebuilds the `BottomState` from current engine/widget state and triggers one `render()` call whose string is written via `Terminal.write()`. The footer is structurally painted last at row `stdout.rows`; no event path can shift it.

### Message handling (`App.handleMessage`)

Direct port of `App.tsx:handleMessage` mutating `Buffer` instead of React state. Reuses `transcript.ts`'s `toDisplayItems` and `streamDelta` unchanged:

1. **Stream delta** (`streamDelta(msg)` non-empty): append to a private `streamingText` field; mark `bottom.streaming = true`; do NOT commit to Buffer yet.
2. **DisplayItems produced** (`toDisplayItems(msg)` non-empty): lay out and `Buffer.append` each. For an `assistant` item, clear `streamingText` and `bottom.streaming`. Track current active tool label from the last `tool` item.
3. **`type: "result"`**: commit any residual `streamingText` as one `assistant` item via `Buffer.append`; clear streaming/activeTool; update `cost`, `tokens`, `contextPct`, `turnCount`; trigger auto-compact at ≥80% (the existing `runAutoCompact` logic, ported as-is).

The key behavioral change vs today: completed items go into the **in-app `Buffer`**, never host scrollback. The host terminal is in alt-screen and has no scrollback at all.

### Key routing (`App.handleKey`)

Phase 1 — globals (first match wins): `Ctrl-C` (the double-tap-to-exit rule from `App.tsx:390-394`); `Ctrl-L` (clear + repaint); `Esc` while streaming (interrupt the turn).

Phase 2 — scrollback navigation (only when `bottom.overlay === "none"`): `PgUp`/`Ctrl-B` scroll up by region height; `PgDn`/`Ctrl-F` scroll down; `Home` jumps to buffer top; `End` resets to stick-to-bottom.

Phase 3 — focus owner: if `bottom.overlay !== "none"`, `overlay.handleKey(k)` consumes the key (overlays are modal — scrollback keys are disabled while one is open, matching today's behavior). Otherwise `BackTab` cycles permission mode, and the key goes to `inputBox.handleKey(k)`.

### Scrolling

`scrollOffset` is either a row-count-from-top number or the sentinel `null` (stick-to-bottom, the default). Any scrollback key sets it to a concrete number; new `Buffer` appends while `scrollOffset !== null` do not move the visible window (the user is reading history), and a hint appears in the StatusBar prompting `Press End to jump to latest`. Pressing `End` resets to `null`, after which new appends automatically follow.

## Key Decoding (`src/ui/input.ts`)

A `KeyDecoder` class with `feed(chunk: Buffer): Key[]`. Bytes that do not yet form a complete escape sequence are retained in an internal buffer for the next `feed()`.

Emits a discriminated `Key` union:

```
type Key =
  | { t: "printable"; ch: string }
  | { t: "paste"; text: string }     // bracketed-paste payload
  | { t: "enter" } | { t: "tab" }
  | { t: "backtab" }                  // \x1b[Z
  | { t: "backspace" } | { t: "delete" }
  | { t: "esc" }
  | { t: "up" } | { t: "down" } | { t: "left" } | { t: "right" }
  | { t: "home" } | { t: "end" }
  | { t: "pgup" } | { t: "pgdn" }
  | { t: "ctrl"; ch: string } | { t: "alt"; ch: string };
```

**Recognition table:**

- `\r` / `\n` → `enter`
- `\t` → `tab`; `\x1b[Z` → `backtab`
- `\x7f` → `backspace`; `\x1b[3~` → `delete`
- `\x1b[A/B/C/D` and `\x1bOA/B/C/D` → arrows (both cursor-mode variants)
- `\x1b[H`/`\x1b[F`/`\x1b[1~`/`\x1b[4~`/`\x1bOH`/`\x1bOF` → Home/End
- `\x1b[5~`/`\x1b[6~` → PgUp/PgDn
- Bytes `0x01..0x1A` → Ctrl-A..Z (`\x03` = Ctrl-C, `\x06` = Ctrl-F, `\x02` = Ctrl-B)
- `\x1b` then a single printable → Alt+that printable
- `\x1b[200~...text...\x1b[201~` → `{ t: "paste"; text }` (bracketed paste)

**Escape-vs-Alt disambiguation.** `\x1b` is both Escape and the prefix of every escape sequence. On seeing a lone `\x1b`, the decoder waits up to 25ms for more bytes (timer reset on each `feed()`): more bytes → parse as escape-sequence continuation; none → emit `esc`. Without this, pressing Escape alone to dismiss a menu would be lost inside `\x1b[A` (Up).

**Non-TTY fallback.** The `KeyDecoder` is only constructed for TTY stdin. When `process.stdin.isTTY === false`, `Terminal` skips raw mode, never instantiates a `KeyDecoder`, and instead reads `stdin` line-by-line on its own, synthesizing each finished line as one `Key` of `{ t: "paste"; text: line }` and forwarding the list to `App.handleKeys(Keys[])`. The decoder stays a pure raw-mode concern. Render output on the non-TTY path is plain unescaped text (no alt screen). This is the path the test suite exercises — tests inject pre-decoded `Key[]` lists directly, bypassing both `Terminal` and `KeyDecoder` entirely.

## Buffer and Layout

### `buffer.ts`

An append-only `Buffer` storing DisplayItems (pre-wrap), with a cumulative-rows index for fast seeking:

```ts
export class Buffer {
  append(item: DisplayItem): void;
  visibleWindow(startRow: number | null, height: number,
                width: number, theme: Theme): { rows: string[]; tailRow: number };
  totalRows(width: number, theme: Theme): number;
  clear(): void;
}
```

- **Store DisplayItems, not pre-wrapped rows.** A resize changes the wrap width; storing DisplayItems means `visibleWindow` re-wraps only the visible window per frame — O(region height), not O(total history).
- **Cumulative-rows index.** `rowOffsets: number[]` where `rowOffsets[i]` = total rows items `0..i-1` occupy at the cached width; lazily rebuilt when `width` changes. Finding the item containing row R is a binary search (O(log N)); laying out it + the next few items is O(visible window).
- **No eviction.** A DisplayItem is a few hundred bytes; 10k items ≈ a few MB — fine. The previous `<Static>` approach didn't evict either.
- **`/clear`** = `this.items = []; invalidate()`.

### `layout.ts`

Pure helpers and per-kind DisplayItem → styled wrapped rows. Ports `bottomFill.ts`'s ANSI-stripping regex (`ANSI_RE`) and `wrappedRows` math, plus a new `wrapText(text, width)` that returns row strings (not just counts), and `stripAnsi(text)`. The per-kind formatting mirrors `MessageList.renderItem` exactly:

```ts
export function layoutItem(item: DisplayItem, theme: Theme, width: number): string[];
```

- `user`: `"> "` prefix, `theme.user`, wrapped.
- `assistant`: `renderMarkdown(item.text)` (markdown.ts unchanged), wrapped at `width`.
- `tool`: `"⏺ "` prefix, `theme.accent`, wrapped.
- `notice`: `theme.muted`, wrapped.
- `error`: `theme.error`, wrapped.
- `diff`: 2-column left pad, per-line `"± " + text` colored by sign, each diff line wraps inside `width - 2` to preserve indent.
- `result`: one row `"✓ done · $cost · duration"`, `theme.muted` dim.

## Bottom-Region Widgets

### Pure widgets (no state across frames)

- **`statusBar.ts`** — `renderStatusBar(p: StatusBarProps, theme, width): string`. One row. Segments joined with `" · "` in `theme.muted`: `provider/model`, `mode`, `⎇ branch*`, `tokens (ctx%)`, `$cost`, `elapsed`, `cwd`. `formatTokens`/`formatElapsed` from `StatusBar.tsx:19-31` copied verbatim.
- **`workInd.ts`** — `renderWorkInd(frame: number, label: string, elapsedMs: number, theme): string`. Spinner cycling `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (frame advances on `tick()`), `theme.accent` label, `theme.muted` elapsed.
- **`progress.ts`** — `renderProgress(label: string, pct: number, theme, width): string`. `[██░░░░░] NN%` bar.
- **`menu.ts`** — `renderMenu(suggestions, selected, theme, width): string[]`. Up to `MAX_ROWS=8` rows. Reuses `visibleWindow` and `MAX_ROWS` from the existing SuggestionMenu math.

### Stateful widgets (live across frames via instance fields on `App`)

- **`inputBox.ts`** — class with `value`, `cursor`, `selected`, `suggestions`, `draft`, `suppressed`, `hadAtToken`. `handleKey(Key)` is a direct port of `InputBox.tsx:162-233` accepting the typed `Key` instead of ink's `(input, key)`; `handlePaste(text)`. `render(theme, width)` returns `{ borderRows: string[]; contentRows: string[]; menuRows: string[]; hintRow: string | null; totalRows: number }` — same round border, same `"█"` cursor glyph, same `"> working… (Esc to interrupt)"` hint when disabled. Behaviors ported verbatim: backslash-continuation newline, `acceptIsNoop`, history-recall draft, `@`-token-driven file-cache refresh, menu `suppressed` after Escape closes it, `Math.min(selected, menu.length-1)` for accept. No React state-lag — `handleKey` runs synchronously and `render()` is called immediately after.
- **`overlay.ts`** — `OverlayManager` with mode `'none' | 'resume' | 'project' | 'permission'`, `openResume`/`openProject`/`openPermission`, `handleKey`, `render(theme, width)` returning `string[]`, and an `get isOpen(): boolean` getter (consulted by `App.handleKey`'s phase 3 to decide whether the overlay or the inputBox is the focus owner). Each sub-mode is a port: `ResumePicker.tsx`, `ProjectPicker.tsx`, `PermissionDialog.tsx`. `MAX_ROWS=8` windowing (reusing `visibleWindow`) so overlay height is bounded at `border(2) + header(1) + 8 entries = 11` regardless of list length — the same cap `App.tsx:441` uses today.

## Frame Composition (`render.ts`)

`render(buffer, scrollOffset, bottom, theme, size): string` paints, in order, into one ANSI string:

1. `\x1b[2J\x1b[H` — full clear + cursor home.
2. **Transcript region** (rows 1 .. `rows - footerHeight`, inclusive — region height = `rows - footerHeight`): if `scrollOffset === null`, slice the buffer's tail window for the available height; otherwise slice `[scrollOffset, scrollOffset + height)`. Each row is already an ANSI-styled wrapped string from `Buffer.visibleWindow`; write `\x1b[<row>;1H` + the row.
3. **Footer region** (rows `rows - footerHeight + 1` .. `rows`, inclusive — the last `footerHeight` rows, ending exactly at row `stdout.rows`), assembled bottom-up:
   - `StatusBar` always last — painted at row `stdout.rows`, structurally pinned.
   - `InputBox` (border + content + hint + menu) immediately above the StatusBar.
   - Open overlay, if any, immediately above the InputBox.
   - `ProgressBar` (if compacting), `WorkingIndicator` (if streaming), and the streaming-text tail (if `bottom.streamingText !== ""`) above the overlay.
   - `footerHeight` is computed synchronously each frame from the widgets actually visible — no `measureElement` lag.

`streamTailCap = max(3, rows - footerHeight - 3)` mirrors `App.tsx:427`, reserving room for the remainder of the bottom region below the stream tail.

## Testing

Three tiers, all runnable headless. A `FakeTerminal` (`isTTY: false`, captures every `write()` call's string in an array, never touches `process.stdin`/`stdout`) lets `App` be constructed in tests without monkey-patching; the real `Terminal` is only instantiated in `cli.tsx`.

### Tier 1 — pure units

- `tests/layout.test.ts` — `wrapText`, `stripAnsi`, `layoutItem` per kind (asserts on the styled strings, not just row counts), `tailForHeight` (moved from `streamTail.test.ts`). Migrates the wrap-math intent of `bottom-fill.test.ts:14-50`.
- `tests/buffer.test.ts` — `append`/`visibleWindow`/`totalRows`, including cross-width re-wrap (resize), the index binary search, stick-to-bottom vs. user-scrolled windowing, `/clear`. Migrates `staticRows` tests' intent (sums at cap, early-exit-at-cap, empty-returns-0 — `bottom-fill.test.ts:50-65`) into `Buffer.visibleWindow` terms.
- `tests/widgets.test.ts` — `renderStatusBar` (asserts the segment-join string), `formatTokens`/`formatElapsed`, `renderMenu` (`MAX_ROWS` windowing, `visibleWindow` start/end math), `renderWorkInd` across frames, `renderProgress`.
- `tests/input.test.ts` — `KeyDecoder.feed`: byte sequences → `Key[]`, multi-key chunks (paste, fast typing), bracketed-paste framing, the escape-vs-Alt 25ms disambiguation (fake-clock injected). The non-TTY fallback is NOT tested here — it lives in `Terminal`, and the test suite bypasses `Terminal`/`KeyDecoder` by injecting `Key[]` lists directly into `App`.

### Tier 2 — widget behavior

- `tests/inputBox.test.ts` — `handleKey` sequences → `render()`: cursor move, backspace, history recall round trip, `acceptIsNoop` Enter vs. plain Enter, backslash-continuation newline, `@`-token cache refresh trigger, disabled hint, suggestion-menu navigation. Direct-port of the intent behind `inputBox.test.tsx` and `completion.test.ts` against the new class API.
- `tests/overlay.test.ts` — `OverlayManager` open/handleKey/close for each sub-mode: resume picker index bounds; project picker; permission dialog hotkeys (`y`/`n`/`a`/`d`), arrow nav, Enter, Esc deny.

### Tier 3 — render & integration

- `tests/render.test.ts` — `render(buffer, scrollOffset, bottom, theme, {rows: 24, columns: 80})` → string. Asserts: footer is pinned at row 24 (a `\x1b[24;1H` somewhere in the string and the StatusBar segment is the last row), no filler gap; streaming tall text is tail-capped to fit; overlay takes over the focus rows; `scrollOffset` change moves the visible window without moving the footer. **This is the test that locks the pinned-footer property the whole rewrite exists to deliver.**
- `tests/app.test.ts` — integration driving a non-TTY `App` against the same `fakeClient`/`textTurn`/`toolUseTurn` harness from today's `app.test.tsx:51-67` (reused verbatim — only touches the engine boundary). Asserts the user message is in the buffer, the assistant reply is appended on `result`, cost/token updates flow to `StatusBarProps`, auto-compact fires at 80%, the StatusBar is the last row of every emitted frame.

### Coverage parity

| Old (deleted)                       | New                                        |
|-------------------------------------|--------------------------------------------|
| `tests/app.test.tsx`                | `tests/app.test.ts` (intent migrated)      |
| `tests/bottom-fill.test.ts`         | `tests/layout.test.ts` + `tests/buffer.test.ts` |
| `tests/streamTail.test.ts`          | `tests/layout.test.ts` (kept)              |
| `tests/markdown.test.ts`            | kept verbatim                              |
| `tests/transcript.test.ts`          | kept verbatim                              |
| `tests/theme.test.ts`               | kept verbatim                              |
| `tests/welcome.test.ts`             | kept verbatim                              |
| `tests/useGitStatus.test.tsx`       | `tests/useGitStatus.test.ts` (React removed) |
| `tests/inputBox.test.tsx`           | `tests/inputBox.test.ts`                   |
| `tests/suggestionMenu.test.tsx`     | `tests/widgets.test.ts` (menu section)     |
| `tests/resumePicker.test.tsx`       | `tests/overlay.test.ts` (resume section)   |
| `tests/projectPicker.test.tsx`      | `tests/overlay.test.ts` (project section)  |
| `tests/permissionDialog.test.tsx`   | `tests/overlay.test.ts` (permission section) |
| `tests/statusBar.test.tsx`          | `tests/widgets.test.ts` (statusBar section)|
| `tests/messageList.test.tsx`        | `tests/buffer.test.ts` + `tests/render.test.ts` |
| `tests/workingIndicator.test.tsx`   | `tests/widgets.test.ts` (workInd section)  |

The 44 non-UI test files (`engine-*`, `commands.test.ts`, `completion.test.ts`, `session*.test.ts`, `skills*.test.ts`, etc.) are **untouched**.

## Dependencies & Config Changes

Remove from `package.json` deps: `ink`, `ink-spinner`; devDeps: `@types/react`, `@types/marked-terminal`, `react-devtools-core`, `ink-testing-library`. `react` itself: was a direct dep at `^18.3.1` (package.json:38); remove too. Keep `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `marked`, `marked-terminal`.

`tsconfig.json`: drop `"jsx": "react-jsx"` (line 6). The remaining flags (`target`, `module`, `moduleResolution`, `strict`, etc.) are unchanged.

`package.json` scripts: `dev` becomes `tsx src/cli.ts` (no JSX). `build`, `package:npm`, `package:bin`, `package:installer`, `package` unchanged.

## Cleanup & Exit Path

`Terminal.cleanup()` does exactly three things, idempotent (safe to call multiple times):

1. `process.stdin.setRawMode(false)` — restore cooked mode so the shell echoes keys normally.
2. `process.stdin.pause()` — stop the data listener.
3. Write `\x1b[?2004l` (leave bracketed paste) + `\x1b[?25h` (show cursor) + `\x1b[?1049l` (leave alt screen — restores pre-app terminal contents and scrollback).

`cli.ts` wraps the `App.run()` call in `try/finally`, calling `cleanup()` in the `finally`. Signal handlers (`SIGINT`, `SIGTERM`, `SIGHUP`, `beforeExit`, `uncaughtException`) all call `cleanup()`. Alt screen is a terminal-emulator state, so cleanup still works if the process crashes mid-frame. The existing Ctrl-C double-tap rule (`App.tsx:390-394`) calls `cleanup()` then `process.exit(0)`. An uncaught exception inside `App` is caught at `cli.ts`, prints the stack to the top of the transcript region *before* cleanup (preserving the error context via alt-screen restoration), then re-throws after cleanup so Node's normal `1` exit and stack trace happen in the user's restored shell.

## Rollout

Incremental, not big-bang — the tree stays green at every checkpoint:

1. **Land `term/` + `layout.ts` + widgets as inert siblings**: new files added, not wired to `cli.ts`. Tier 1 tests pass against the new pure code; the old UI keeps running. No behavior change.
2. **Land `Buffer` + `App` skeleton + non-TTY fallback**: Tier 2 tests pass. `App` exists but is not yet invoked by `cli.ts`. Old UI still runs in production.
3. **Add `--tui native` CLI flag** in `cli.ts`'s `parseArgs` (under `options`). Construct `new App(...).run()` when set; otherwise `render(<App/>)`. Old UI is default; new UI opt-in for dogfooding. Both code paths exist; build passes; either UI can be launched.
4. **Stabilize the new TUI**: fix issues found in real-terminal dogfooding (Windows Terminal, conhost, iTerm2, SSH). Each fix validated against the new test suite.
5. **Flip the default**: `--tui native` becomes default; old UI becomes `--tui legacy` for one release, then deleted in the following release.

At each checkpoint: `npm run build` clean, `npm test` green (the deliberate test rebuild in steps 1-3 lands in lockstep with the code, so the deleted old UI tests disappear as the new tests appear).

## Out of Scope

- **Engine, agent, commands, sessions, providers, MCP, skills**: any change to these subtrees.
- **Diff-based incremental repaint** (Approach B from the brainstorm). A possible future optimization if profiling shows full-repaint cost matters; the `render()` contract doesn't change, only its implementation.
- **DECSTBM scroll region** (Approach C from the brainstorm). Rejected for Windows conhost compatibility risk; no user-visible benefit over full repaint.
- **Keeping `ink-testing-library` or any React-based test harness.** The new tests are JSON/string-based.
- **Mouse support inside the TUI.** Mouse wheel scrolling of host scrollback is unavailable in alt-screen by design; in-app mouse scrolling (SGR mouse mode) is a possible future feature, not part of this rewrite.
