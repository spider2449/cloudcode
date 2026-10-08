# Windows 10 1909 compatibility investigation

## Scope and plan

1. Inspect current startup, terminal compatibility, packaging, and previous crash findings.
2. Check upstream platform requirements and separate desktop failure from TUI rendering defects.
3. Run focused regression tests and record confirmed defects and remaining native checks.

This investigation does not change runtime behavior or build a release.

## Evidence

- Baseline: HEAD 7418cb3, version 0.1.153, initially clean worktree.
- Local operating system: 10.0.19045, not the reported 1909 build 18363.
- Seven focused Vitest files passed, 120 tests total: terminal, render,
  render-simple, input, inputBox, inputBox-width, and packaging.
- Current desktop chat uses a piped GUI backend in shell/main.mjs, not a
  node-pty spawn. The node-pty dependency alone does not establish a ConPTY
  cause for desktop chat failures.

## Confirmed code gaps

1. terminal.ts enables the native cursor on build 18363, while
   widgets/inputBox.ts unconditionally inserts a synthetic block at the
   same cursor position. No suppression exists in current source. Native
   visual severity and candidate-window behavior still need a 1909 probe.
2. widgets/menu.ts explicitly ignores width. Long completion descriptions
   can exceed the screen width. InputBox hint rows are also unbounded.
   InlineRenderer joins these footer rows directly; it wraps streaming and
   thinking rows but does not constrain every footer row. On terminals
   that wrap despite DECAWM-off, physical row counts can diverge from the
   renderer's footer accounting. Actual 1909 artifacts remain unverified.
3. Release smoke tests run on windows-latest and exercise --version, not
   interactive IME, resize, tool-output bursts, or Windows 1909 startup.
   Passing these tests does not certify the reported environment.

## Desktop crash priorities

The existing 2026-10-08-desktop-crash-investigation.md records a reproduced
old-child/new-child lifecycle race, a missing ELECTRON_RUN_AS_NODE setting
on Electron fallback, discarded backend error details, missing termination
handlers, and unbounded scan/tool-output allocation paths. These remain
separate candidates from OS-specific terminal behavior. Do not attribute
whole-window disappearance to an IME or scrollback defect.

Next work should persist main/backend/renderer termination evidence and
test child callback identity and packaged fallback startup. Native 1909
checks should use the failing installed build and record Electron/Node
versions, launch route, architecture, memory, terminal host, input method,
GPU/driver, and whether the window or only its backend disappears.

## Upstream distinctions

- Current Windows Terminal requires build 19041 or later. A 1909 machine
  necessarily uses another host or an older Terminal release:
  https://github.com/microsoft/terminal
- Microsoft issue 3673 reports scroll-region scrollback loss on build
  18362.418. Current InlineRenderer disables scroll regions for all win32:
  https://github.com/microsoft/terminal/issues/3673
- Electron 44 removes Windows x86 prebuilt binaries. Verify architecture
  rather than treating every Windows 10 machine as the same target:
  https://www.electronjs.org/blog/electron-44-0
- Current Bun documentation describes unified SSE4.2 x64 binaries, but
  local Bun is 1.3.14 and build scripts do not pin its version. Current
  documentation does not establish the CPU requirements of an older
  installed executable:
  https://bun.sh/docs/bundler/executables

## Outcome

Confirmed source-level rendering gaps and diagnostic/coverage gaps were
identified. No Windows 1909 native reproduction or crash fix is claimed.
