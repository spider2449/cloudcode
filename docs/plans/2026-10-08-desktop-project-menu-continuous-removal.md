# Continuous project removal

Keep the project popup open after removal, preserve its scroll position, and
focus the next removal button. Close only when the list is empty or through
normal selection, Escape, or outside click. Verify consecutive removals in
the isolated Electron fixture and package version 0.1.153.

## Validation

- Electron fixture confirms the popup remains open after deleting the active
  project, focus moves to the next removal button, and two further removals
  preserve scrollTop=300. Removing the remaining 27 projects closes the empty
  popup and disables the trigger.
- Existing 30-project viewport checks still pass at heights 870 and 300.
- Three focused Vitest files passed (40 tests); desktop build, desktop type
  checking, lint, and diff checks passed.

## Acceptance and commit checks

The operator accepted the installed desktop behavior and requested commit and
push. No implementation changes followed acceptance. Full Vitest validation
with an isolated user profile passed: 195 files passed, one skipped; 1558
tests passed, three skipped. Build, desktop type checking, lint, size check,
and diff checks passed; nativeApp.ts retains its existing 608-line soft warning.
The source version is 0.1.153, advanced from the 0.1.151 commit baseline.
