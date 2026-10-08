# Desktop crash investigation

## Scope

Inspect desktop startup, backend lifecycle, error boundaries, existing tests,
and locally available crash evidence. Do not change runtime behavior or package
a release during this investigation.

## Completed checks

- The initial worktree was clean; source version is 0.1.151. The newest local
  installer is 0.1.150, so installed behavior may differ from the checkout.
- Inspected Electron main, runtime selection, GUI backend/server, renderer,
  packaging configuration, and relevant tests.
- Reproduced backend lifecycle races using the actual main-process function
  bodies in an isolated VM with EventEmitter-based child process doubles.
- Focused Vitest invocation: 9 test files and 76 tests passed. Desktop
  TypeScript checking passed.
- No matching CloudCode/Electron/Node application crash events were returned
  by the Windows Application event query for the last seven days.

## Findings

1. Confirmed backend lifecycle race: callbacks access the shared chatChild
   instead of checking the identity of their own child. A delayed exit from
   an old child clears the new child reference; a delayed stdin error from
   an old child kills the new child. The isolated reproduction confirmed both.
   This explains backend loss and possible untracked children, but does not
   establish a cause of the whole desktop window disappearing.
2. Runtime fallback returns the Electron executable when Node is unavailable,
   but the chat backend spawn does not set ELECTRON_RUN_AS_NODE. That fallback
   does not implement the Node-mode behavior promised in runtime.ts. This is
   a conditional startup failure candidate, not a reproduced user crash.
3. Backend errors lose diagnostic information: spawn and stdin errors are
   discarded, exit codes/signals are omitted, and stderr is inherited rather
   than persisted. Installed GUI launches may therefore provide no useful log.
4. Window load promises and app readiness have no rejection handler. There
   are no render-process-gone/child-process-gone handlers, crash reporter, or
   React error boundary. Missing renderer assets, renderer exceptions, and
   native/GPU failures are not distinguished by the current diagnostics.
5. Existing pipe-safety tests largely inspect source strings and cannot catch
   the confirmed lifecycle race. The passing suite is not native crash proof.

## Next diagnostic and repair steps

- Obtain the failing version, launch method, trigger, and any error text.
- Bind child handlers to their own process identity and add event-order tests.
- Make Node-mode fallback explicit and verify it in a packaged environment.
- Persist startup/backend/renderer termination evidence, including code,
  signal, and error stack, with an accessible log location.
- Reproduce the original trigger using the matching installed build before
  claiming the desktop crash has been fixed.

## Follow-up: intermittent failure after codebase review

The operator reports an intermittent failure after codebase review. Whether
the entire window closes or only the backend fails remains unknown.

- Read loads the complete file before selecting lines and has no text byte
  or output character cap. A temporary synthetic 4 MiB single-line file,
  requested with limit=1, returned 4,194,306 characters without an error.
  The temporary file was removed. This confirms a missing bound, not OOM.
- Grep checks its 2 MiB text limit only after readFileSync has allocated the
  complete file. Glob/Grep walk materializes all discovered paths before
  applying result limits. These can increase backend memory during a scan.
- Tool results pass through the engine and desktop event mapping without a
  general output cap. The Electron shell JSON-parses complete output lines
  and forwards them even when ChatPane ignores tool_result events. Large
  results therefore still incur transport and allocation costs.
- ChatPane retains and renders the whole visible transcript. Each assistant
  text change reparses and sanitizes its full Markdown text. Memoization
  protects unchanged bubbles, but does not bound a growing review response.
- Foreground Bash already caps its child output buffer at 10 MiB and its
  returned text at 30,000 characters. The Git review collector also has
  bounded output collection. These routes should not be conflated with Read.
- Session persistence failures are caught; automatic memory extraction is
  best-effort with a rejection handler. No deterministic ordinary exception
  causing full-window closure was established in these completion paths.

Prioritize crash/exit diagnostics and byte-bounded file reads when pursuing
this trigger. The previously confirmed restart race remains relevant to
recovery, but is not evidence that it initiates this review-time failure.

## Follow-up: installed application window disappears

The operator confirms the installed application and disappearance of the
entire window. Live executable metadata identifies the current installation
as 0.1.150.0; source HEAD is 0.1.151. Four CloudCode processes were running
at inspection time; no running instance was stopped or modified.

Windows WER archives contain five older CloudCode BEX64 reports from
September 4 and September 8, for versions 0.1.13, 0.1.20, and 0.1.41.
They share exception code c0000409 and exception data 7. These establish
historical native application failures, not the cause of the reported
0.1.150 review failure. No current-version report or local crash dump was
found in the checked locations.

The shell backend-exit handler only sends a renderer error; it does not
close the window. Consequently backend memory exhaustion alone does not
explain window disappearance. Investigate main/native termination, total
system memory pressure, and explicit window-close behavior separately.
Renderer failure alone also does not establish that the main process exits.

HEAD includes idle-status-loop removal and Markdown memoization absent from
the installed 0.1.150 build. These reduce unnecessary renderer work, but
there is no evidence that they fix the reported crash. A current packaged
build with persistent termination diagnostics is needed to attribute the
next occurrence, rather than treating the older WER signature as current.
