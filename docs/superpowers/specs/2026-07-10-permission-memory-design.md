# Permission Memory — Remember Allow/Deny per Directory: Design

Date: 2026-07-10
Status: Approved
Builds on: v1 + v2 specs (implemented on master)

## Goal

Stop repeated permission prompts: a user can answer a Read/Write/Edit permission
request with "always allow this directory" or "never allow this directory", and
cloudcode remembers that decision for the project.

## Storage

`<project cwd>/.cloudcode/permissions.json` — lives in the project so rules follow
the repo. Format:

```json
[
  { "tool": "Write", "dir": "F:/proj/src", "decision": "allow" },
  { "tool": "Read",  "dir": "F:/proj/secrets", "decision": "deny" }
]
```

README documents: add `.cloudcode/` to the project `.gitignore` if rules should not
be version-controlled.

## PermissionStore (`src/agent/permissionStore.ts`)

- `class PermissionStore { constructor(cwd: string); check(tool: string, filePath: string): "allow" | "deny" | undefined; remember(tool: string, filePath: string, decision: "allow" | "deny"): void; list(): PermissionRule[]; clear(): void }`
- `remember` stores `dir = dirname(filePath)` (normalized); persists immediately.
- `check` matches when the file's path is inside a rule's `dir` (including
  subdirectories). Paths are normalized to forward slashes and compared
  case-insensitively (Windows). **Deny rules take precedence over allow.**
- Corrupt/missing file → empty rules (same tolerant-load pattern as providers/
  sessions/history).
- Duplicate rules (same tool + dir) are replaced by the newest decision.

## Interception (App `onPermissionRequest`)

- Only requests whose input has a string `file_path` consult the store:
  - `check` → `"allow"`: resolve(true) immediately, no dialog; gray notice
    `auto-allowed: <Tool> <path> (rule)`.
  - `check` → `"deny"`: resolve(false) immediately; gray notice
    `auto-denied: <Tool> <path> (rule)`.
  - undefined: queue the dialog as today.
- Tools without `file_path` (e.g. Bash) never consult or write memory; their
  dialog keeps plain Yes/No (YAGNI).

## PermissionDialog upgrade

- For requests with `file_path`, four options: `Yes (y)`, `Always for this
  directory (a)`, `No (n)`, `Never for this directory (d)`. Arrow keys move the
  selection, Enter confirms, hotkeys act directly. Esc = plain No (unchanged).
- Choosing `a`/`d` calls `remember()` with the corresponding decision, then
  resolves the request.
- For requests without `file_path`, the dialog keeps the existing two options.
- The dialog receives an `onDecision(allow: boolean, rememberAs?: "allow" | "deny")`
  callback; the App owns the store and performs `remember`.

## Slash command

- `/permissions` extends: `/permissions list` prints the project's rules (or
  "No permission rules."); `/permissions clear` deletes all project rules with a
  notice. `/permissions <mode>` behavior is unchanged. `CommandContext` gains
  `listPermissionRules(): string` and `clearPermissionRules(): void`.

## Error handling

- Store write failures (e.g. read-only project dir) surface as an error notice;
  the in-memory rule still applies for the session.
- Malformed rule entries in the file are skipped on load.

## Testing

- PermissionStore unit tests: exact dir match, subdirectory match, non-match,
  deny-over-allow precedence, duplicate replacement, case-insensitive match,
  corrupt file tolerance, persistence across instances, clear().
- App integration tests (mocked queryFn issuing canUseTool): remembered allow
  skips the dialog and auto-resolves; choosing "Always" writes a rule and the next
  identical request auto-resolves; deny rule auto-denies.
- PermissionDialog tests: four options render for file_path requests, `a`/`d`
  hotkeys report rememberAs, two options for non-file requests.

## Out of Scope (YAGNI)

- Bash command pattern rules, glob patterns, rule editing UI, global (cross-
  project) rules, expiry.
