# CI dependency audit repair

The CI run for 5eae3f3 failed only in `npm audit --audit-level=high` with five high and one critical dependency findings. Build and test jobs succeeded.

1. Update the affected dependencies within existing version ranges, preserving the audit threshold and avoiding forced major upgrades.
2. Inspect the resulting lockfile and audit report; leave unrelated moderate findings outside this repair if they require incompatible changes.
3. Run the CI validation commands locally, increment the patch version, commit and push the repair, and verify the new GitHub Actions run.

Original run: https://github.com/spider2449/cloudcode/actions/runs/37717896505

## Local results

- Updated only the six targeted dependency families in the lockfile, including MCP SDK 1.30.0 to 1.32.1. Existing manifest ranges were retained.
- Audit passed at the unchanged high threshold: zero high or critical findings; one low and ten moderate findings remain.
- Lint, size check, TypeScript build, desktop build, desktop typecheck, and whitespace validation passed. The existing `nativeApp.ts` size warning remains.
- Full suite: 198 files passed, one skipped; 1567 tests passed, three skipped.
- Patch version incremented consistently to 0.1.156.
