# Design: Version Bump on Every Commit

Date: 2026-08-26

## Problem

The project's version lives in three places (`package.json`, `src/version.ts`,
`installer/cloudcode.iss`) and `tests/packaging.test.ts` pins them to agree.
Version bumps currently happen only when someone remembers to make them, so
commits ship with stale versions.

## Decision

Before every git commit made in this repository, increment the **patch**
version (`0.1.0` → `0.1.1`) in all three files and include those changes in
that same commit:

- `src/version.ts` — `export const VERSION = "..."`
- `package.json` — top-level `"version"` field
- `installer/cloudcode.iss` — `AppVersion` directive

The rule is recorded in `AGENTS.md` (new "Versioning" section) so every future
session follows it.

## Rejected alternatives

- **Git pre-commit hook** (plain or husky-managed): rejected by the user; the
  bump is an agent/workflow convention, not enforced tooling.
- **Bumping only `src/version.ts`**: breaks `tests/packaging.test.ts`, which
  requires all three files to state the same version.

## Testing

No code changes. Verification: run the packaging test
(`npx vitest run tests/packaging.test.ts` or equivalent test runner command)
after applying the rule to confirm the three-file agreement holds.
