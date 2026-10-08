# Desktop idle CPU and transcript selection

1. Inspect idle IPC and transcript rendering. The status response emits `done`, and the renderer requests another status for every `done`, creating an unbounded feedback loop.
2. Exclude status-query completion events from event-triggered status refreshes while preserving turn completion refreshes and periodic polling.
3. Preserve unchanged Markdown DOM and release resize selection locks when the window loses focus.
4. Add regression coverage, run desktop typechecking, builds, lint, and relevant tests. Verify idle request counts and text selection in an isolated Electron renderer where possible.

The user confirmed manual testing passed and requested a patch version bump, commit, and push. Version 0.1.151 includes this fix. Release packaging is outside this request.

## Validation

- Desktop typecheck and desktop build passed.
- Lint passed. Size check passed with the existing 608-line nativeApp.ts warning.
- Main checkout suite: `npx vitest run --exclude '**/.worktrees/**'`: 390 files passed, 2 skipped; 3,094 tests passed, 6 skipped.
- Unfiltered `npm test` additionally discovered stale tests in `.worktrees/busy-theme`, causing 10 missing-path failures outside the main checkout.
- `node scripts/test-desktop-idle.mjs`: isolated Electron renderer retained native selection, made 6 bounded status requests over approximately 11 seconds, recorded zero unchanged-Markdown mutations, and released the resize selection lock on blur.
- The user reported testing passed before authorizing commit and push. No independent hardware CPU measurement is claimed.
- Version 0.1.151 packaging consistency tests, desktop typecheck, and desktop build passed before commit.
