# Desktop repository restore

## Plan

1. Inspect restart persistence and preserve existing user configuration.
2. Reproduce repeated repo attachment and workspace identity updates.
3. Fix stale-value overwrites and isolate shell-host tests from user state.
4. Run regression tests, build, desktop type checking, lint, and diff checks.

## Findings

- Untitled workspace saves spread old entries after the new value, so a
  second attachment to an existing workspace is not persisted.
- Workspace ID saves use the same stale-value overwrite pattern.
- User recent-project state contains test temporary directories. These can
  evict real projects from its 20-entry limit. Do not delete or reconstruct
  user records without knowing the intended missing project.
- Crash investigation is deferred at the operator's request.

## Clarified requirement and implementation

The operator confirms the project directory is no longer on disk. Restore
now retains unavailable single projects and untitled workspace members,
preserving their repo positions, workspace identity, and session associations.
Refresh updates availability when the original directory returns. New project
selection still requires an existing directory. Git and chat cwd resolution
reject unavailable directories; the composer displays the path and disables
sending. Saved workspace files already preserve missing member directories;
the shared operation guard applies to those members as well.

The original missing directory is not recreated or relocated automatically.
User project state is not edited as part of this repair.

## Test isolation

Vitest also discovered old tests inside .worktrees/busy-theme despite the
selected test paths. Those old tests wrote workspace IDs to the real user
configuration. Exclude .worktrees from discovery and isolate current shell
host tests through a temporary config directory. Do not alter the other
worktree or erase user configuration to undo test-created entries.

## Validation and delivery

- Current focused regression tests: 4 files, 37 tests passed; hashes confirm
  all three user desktop state files stayed unchanged during this run.
- TypeScript build, desktop type checking, lint, and diff checks passed.
  Size check reports the pre-existing 608-line nativeApp.ts soft warning.
- Windows desktop packaging completed successfully for version 0.1.151.
  The unpacked backend includes unavailable-directory guards and placeholder
  restore behavior. The installer has not been installed automatically.
- No native window acceptance or recovery of deleted project files is claimed.

## Remote Desktop question

No direct Remote Desktop, mstsc, msrdc, ActiveX, or rdclientax references were
found in project source, scripts, package metadata, installer, tests, or docs.
The observed msrdc.exe is C:/Program Files/WSL/msrdc.exe and its parent chain
is wslhost.exe, wslservice.exe, services.exe. rdclientax.dll exists in the WSL
installation. This does not identify the screenshot dialog's owning process
or exclude an agent-generated shell command invoking WSL.
