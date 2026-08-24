# Design: Network Storage Permission Settings (UNC + Mapped Drives)

Date: 2026-08-24
Status: Approved

## Problem

File tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) currently force an
`"ask"` permission decision for every path outside the project cwd — which
includes all network storage: UNC paths (`\\server\share\...`) and Windows
mapped drives (`Z:\...`). Users who legitimately work against network shares
get prompted on every operation, even in `bypassPermissions` mode, and have
no way to express "this share is trusted" or "this drive is off-limits".

## Goals

- Per-target allow/deny rules for network storage, configured globally.
- UNC paths and mapped drive letters both supported; each matched
  independently (a rule for `\\server\share` does not implicitly cover `Z:`
  and vice versa).
- Preserve existing security posture: anything not explicitly allowed still
  asks; project-level denies still win.

## Non-goals

- Bash commands touching network paths (already covered by command-prefix
  rules) — out of scope.
- Per-project network rules (user chose global settings.json).
- Auto-discovery of mapped drives.

## Config format

User-global `settings.json` gains one field:

```jsonc
{
  "networkStorage": [
    { "target": "\\\\server\\share", "decision": "allow" },
    { "target": "Z:",                "decision": "deny"  }
  ]
}
```

Rules:

- `target`: a UNC root (`\\server\share`, optionally deeper,
  e.g. `\\server\share\sub`) or a drive-letter root (`Z:` / `Z:\`).
  Normalized at load time to forward slashes + lowercased on win32 (same
  convention as `normalizePath` in `permissionStore.ts`), so
  `\\server\share` is stored as `//server/share`.
- `decision`: `"allow"` or `"deny"` only.
- Validation follows the existing settings pattern: field-by-field type
  guard; malformed entries are dropped silently; unknown sibling keys are
  preserved by merge-on-save (`saveSetting`).

## New module: `src/agent/networkStorage.ts`

Owns types, validation, and matching. Lives in `agent/` because it encodes
machine-level config, not provider-facing logic (per AGENTS.md layering).

```ts
export interface NetworkStorageRule {
  target: string;    // normalized form
  decision: "allow" | "deny";
}

export function isValidNetworkStorageRule(value: unknown): boolean;
export function normalizeNetworkTarget(target: string): string;
export function isNetworkPath(normalizedPath: string): boolean;
export function matchNetworkStorage(
  rules: NetworkStorageRule[],
  normalizedPath: string,
): "allow" | "deny" | undefined;
```

Matching semantics:

1. A path matches a rule if it equals the target or starts with
   `target + "/"`.
2. Mapped-drive paths are checked against **both** the literal drive form
   (`z:/...`) and its resolved UNC form. Drive resolution uses
   `fs.realpathSync` on the drive root and is cached per session (a
   `Map<string, string | null>`); resolution failure (disconnected drive)
   caches as "unavailable".
3. Deny wins: if any matching rule is `deny`, return `"deny"`. Else if any
   matching rule is `allow`, return `"allow"`. Else `undefined`.

Detection: a path is a *network path* if its normalized form starts with
`//` (normalized UNC) or matches `/^[a-z]:/` **and** it resolves outside
cwd. Local fixed drives under such a check that resolve inside cwd never
reach this code path anyway.

## Decision integration: `src/engine/permissions.ts`

In `decidePermission`, after project-store dir rules and before the
outside-cwd forced-`ask`:

1. If the tool's path is outside cwd and `isNetworkPath(...)`:
   - `matchNetworkStorage(...) === "deny"` → return `"deny"`.
   - `=== "allow"` → treat like an inside-cwd path for the rest of the
     flow: reads/searches auto-allowed per READ_ONLY/SEARCH_TOOLS logic;
     edits follow the existing mode logic (`acceptEdits` allows, else
     `ask`). `bypassPermissions` also honors allow-listed shares.
2. No match / not a network path → unchanged behavior (always `ask` for
   outside-cwd).

Precedence summary:

- Project `permissions.json` deny (dir rule) wins over network allow
  (store deny is consulted first).
- Network deny beats everything at the network layer and beats network
  allow within the layer.
- Unmatched network paths keep asking, regardless of mode.

Scope: file tools only (`Read`, `Write`, `Edit`, `Glob`, `Grep`).

## Remembering from the permission prompt

When the `ask` overlay fires for a network path and the user picks
"always allow", `src/ui/permissionController.ts` writes the rule to global
`settings.json` (via the same matching helpers from
`networkStorage.ts` — preserving the documented invariant that decider and
remember-overlay share one scoping function). The stored target is the
deepest applicable root: the resolved UNC share root for UNC paths, or the
drive letter root for mapped drives.

Persist-failure reporting follows the existing controller pattern.

## Error handling

Follows existing conventions rather than adding new boundaries:

- Settings loader drops invalid entries silently (config-loader pattern:
  readFileSync + JSON.parse wrapped, fallback to defaults).
- `fs.realpathSync` failures during drive resolution are caught inside
  `networkStorage.ts` and treated as "no UNC mapping"; the literal drive
  form is still matched. No throw escapes the module.
- No new try/catch in `decidePermission`; it stays a pure decision function.

## Testing

- New `tests/networkStorage.test.ts`: validation, normalization, matching
  (equal/prefix/sibling non-match), deny-wins, dual-form mapped-drive
  matching, resolution-failure fallback.
- `tests/engine-permissions.test.ts`: matrix additions — network allow
  makes outside-cwd reads/edits behave like inside-cwd; network deny
  overrides; unmatched still asks in every mode; store-deny precedence.
- `tests/settings.test.ts`: round-trip of `networkStorage`, malformed-entry
  dropping, unknown-key preservation.
- `tests/permissionController.test.ts`: remembering a network-path answer
  lands in settings.json with the correct root target.

## Module size impact

All new files start well under the ~600-line ceiling; `permissions.ts`
gains roughly 20–30 lines. No splits needed.
