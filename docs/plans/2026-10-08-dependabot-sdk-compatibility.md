# Dependabot removal and Anthropic SDK compatibility

1. Remove the scheduled Dependabot configuration and update its architecture note.
2. Upgrade only `@anthropic-ai/sdk` from 0.124.0 to the verified latest 0.132.0.
3. Exercise the actual SDK against a local HTTP server for stable and beta streaming, authentication headers, request payloads, and cancellation.
4. Run the build, desktop typecheck, lint, size check, and test suite. Record results without claiming live Anthropic service validation.

The user subsequently authorized commit and push. Patch version 0.1.155 is included in all four versioned files.

## Results

- Removed `.github/dependabot.yml`; retained CI dependency auditing.
- Upgraded the SDK and lockfile to 0.132.0; no unrelated dependency updates.
- The real SDK fixture exposed request beta headers replacing the default OAuth beta header. The adapter now explicitly merges and deduplicates beta values.
- Added three local HTTP tests covering stable SSE and payload serialization, OAuth plus context-management beta headers, and pre-request cancellation.
- Build, desktop typecheck, lint, size check, and diff whitespace check passed. The size check retains an existing 608-line warning for `src/ui/nativeApp.ts`.
- Full suite: 198 test files passed, one skipped; 1567 tests passed, three skipped.
- `npm audit` reports 17 dependency vulnerabilities (one low, ten moderate, five high, one critical); resolving other dependencies is outside this change. The audit gate is not green.
- No authenticated request to the live Anthropic service was performed. Removing the configuration takes effect remotely after the change reaches the default branch; existing GitHub PRs were not closed.

Source: https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.132.0
