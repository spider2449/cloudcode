# Desktop Native Chat Design (2026-09-09)

## Goal
Replace the embedded xterm TUI in the desktop GUI with a native
user/LLM dialogue UI (chat bubbles), keeping all existing `/<feature>`
commands working from the input box. Fix IME/input and text
selection/copy pain. The CLI TUI stays untouched as an independent program;
desktop is only a shell over the original cloudcode program.

## Non-goals
- No changes to `src/ui/*` or the interactive CLI TUI behavior.
- No new slash-command semantics; GUI reuses the same registry.
- No PTY/xterm parsing bridge as a permanent solution (rejected option C).

## Approaches considered
- **A. Native engine-direct chat (chosen):** headless backend reusing
  `engine/loop.ts` + `agent/*` + `commands/registry.ts`, speaking NDJSON
  over stdio; Electron main only spawns/forwards; renderer is pure React.
  Fixes IME/copy at the root. Larger change, accepted.
- **B. Dual-mode (rejected):** keep PTY fallback with a toggle. Lowest risk
  but double maintenance and the kill-PTY-on-switch problem remains.
- **C. PTY-parse bridge (rejected):** parse ANSI into bubbles. Zero engine
  changes but input-side IME/copy stays broken and parsing is fragile.

## Architecture
- CLI TUI path unchanged: `dist/cli.js` interactive mode renders via
  `src/ui/*` exactly as today.
- New headless path: `cli.js --gui-server` starts `src/desktop/guiServer.ts`,
  which hosts sessions, builds `EngineOptions`, runs the loop, and routes
  `/cmd` through `commands/registry.ts` (same definitions as TUI, including
  `configChoices`/`applyConfigValue`).
- `desktop/main.mjs` becomes thin: spawn/supervise the child process,
  forward `chat:*` IPC. All `terminal-*` IPC and node-pty usage removed.
- Layering per AGENTS.md: engine stays provider-agnostic and UI-agnostic;
  commands orchestrate; renderer only renders; `src/desktop/` owns the
  transport contract.

## Components
- `src/desktop/guiServer.ts` (new): stdio JSON in / NDJSON events out,
  session hosting, loop + registry dispatch. Split further if near 600 lines
  (contract vs hosting).
- `desktop/main.mjs` (thin): process lifecycle only (start/restart/quit).
- `desktop/preload.cjs` (new surface): `chatSend` / `chatAbort` /
  `chatHistory` / `onChatEvent`. `terminal-*` removed.
- `desktop/renderer/` (new chat components): `ChatPane` message list,
  `InputBox` with `/` autocomplete dropdown, `ToolCard` collapsed tool
  calls, `PermissionOverlay` native allow/deny. Delete `terminalKeys.ts`
  and `imePosition.ts` with xterm. Markdown display reuses the parsing
  approach of `src/ui/markdown.ts` rendered as HTML.
- `/` parity: dropdown lists every registry command; execution path is the
  same function the TUI calls.

## Data flow
1. `InputBox` sends `chatSend({ sessionId, text })`; `/` prefix resolved to
   a registry command locally for autocomplete, executed server-side.
2. `guiServer` runs either the command or an engine turn; each
   `EngineMessage` (`text_delta`, `thinking_delta`, `tool_use`,
   `tool_result`) is emitted immediately as an NDJSON event.
3. Renderer applies events incrementally: streaming text into bubbles,
   tool activity into collapsed `ToolCard`s, permission requests into the
   native overlay (`chatRespond` returns the decision).
4. Session switch = change subscription + `chatHistory` fetch. No process
   kill. In-flight turns can be aborted (`chatAbort`) or left running.

## Error handling
Follows the three AGENTS.md boundaries with native presentation:
1. Per-tool: tool error becomes an error `ToolCard`; turn continues.
2. Per-turn: API/stream failure becomes an error bubble with retry;
   session survives.
3. Per-command: `/` failure becomes a notice; app does not crash.
Transport: child crash shows a banner with Restart + auto-reload of history;
abort marks the message `cancelled` and keeps completed content.

## Testing
- `tests/desktop-guiServer.test.ts`: protocol roundtrip, abort, crash/restart.
- `tests/desktop-chatParity.test.ts`: every `/cmd` resolves to the same
  registry definition as TUI (no drift).
- Keep `tests/packaging.test.ts`, `lint`, and `lint:size` green; new files
  stay under the 600-line guidance with 1:1 test mapping in the same commit.
- Manual acceptance: IME (CJK), select/copy/scroll, `/` autocomplete,
  permission overlay, session switch during a running turn.
