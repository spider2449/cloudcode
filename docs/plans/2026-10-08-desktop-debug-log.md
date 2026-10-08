# Desktop debug logging

## Plan

- Add a bounded, failure-tolerant JSONL diagnostic writer in the desktop backend layer.
- Record startup/platform, backend lifecycle, renderer/native termination, window close, and periodic process memory metadata.
- Enable by default for crash investigation, allow CLOUDCODE_DESKTOP_DEBUG=0, and expose the log folder in Help.
- Exclude chat payloads, environment variables, raw stderr, and console messages.
- Validate rotation, write failures, error metadata, shell event wiring, and desktop builds.

Native hard termination may leave only the last heartbeat. This is diagnostic instrumentation, not a crash fix.

## Validation

- Follow-up: use the environment temporary directory under cloudcode/logs
  instead of userData/logs; verify Windows TEMP override resolution.

- Full suite: 197 files passed, 1 skipped; 1563 tests passed, 3 skipped.
- Build, desktop build, desktop typecheck, lint, and diff check passed.
- Size check passed with an existing 608-line nativeApp.ts soft warning.
- Native Electron 44 launch on Windows build 19045 used isolated temporary
  userData. Startup, renderer-loaded, backend-start, shutdown, backend-exit,
  and main-exit records were persisted; process exit code was zero.
- Logger tests cover bounded rotation across restarts, disabled logging,
  failed filesystem writes, and exclusion of error text. Event-order tests
  cover delayed old-child errors/exits and stderr OOM classification.
- Windows 1909 and packaged installer behavior remain unverified.
