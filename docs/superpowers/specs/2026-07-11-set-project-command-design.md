# /set project Command — Design

Date: 2026-07-11
Status: Approved (Option A — app remount)

## Purpose

Let the user switch cloudcode's working project directory mid-run without quitting
and relaunching the CLI. Switching starts a fresh conversation in the new directory;
all project-scoped state (permissions, skills, MCP servers, file index, git status)
reloads for the new project.

## Command Surface

New builtin command `set` (in `src/commands/builtins.ts`), with subcommands.
Only one subcommand ships now:

- `/set project <path>` — switch to `<path>`.
  - Resolves `~`, `~/...`, and relative paths against the current cwd.
  - Validates the resolved path exists and is a directory; on failure prints a
    notice and changes nothing.
- `/set project` (no argument) — opens an interactive picker of recent project
  directories.
- `/set` (no subcommand) or unknown subcommand — prints usage listing available
  subcommands (currently only `project`).

Tab completion:
- First arg completes subcommand names (`project`).
- After `project `, completes filesystem directories matching the typed prefix.

## Recent Projects Picker

- Source: the session index (`src/agent/sessionIndex.ts`) — each entry records a
  `cwd`. Recent projects = distinct `cwd` values from session entries, most
  recent first. The current directory is included and marked with ● (like
  `/model` output); selecting it just closes the picker with no switch.
- UI: same pattern as the existing resume picker (`openResumePicker` /
  `ResumePicker` component) — a list component rendered in place of the input,
  arrow keys + enter to select, esc to cancel.
- Selecting an entry triggers the same switch flow as `/set project <path>`.

## Switch Flow (Option A: remount)

1. `cli.tsx` gains a small wrapper component that owns `cwd` as React state
   (initialized from `process.cwd()` as today) and renders `<App key={cwd}
   cwd={cwd} ... />`.
2. A `switchProject(path: string)` callback is passed down to `App` and exposed
   on `CommandContext` (`src/commands/types.ts`).
3. On switch:
   - Validate path (exists, is directory).
   - `process.chdir(resolvedPath)` so child processes and relative file access
     use the new directory.
   - Set the wrapper's `cwd` state. The `key` change remounts `App`, so every
     `useRef` initializer (PermissionStore, FileIndex), MCP load, skills scan,
     and git status hook re-runs against the new cwd, and a fresh agent session
     starts.
   - Session resume: switching always starts a fresh session in the new
     directory — `--continue`/`--resume` only apply to the initial mount before
     any switch has happened, never on a remount caused by switching.
   - Show a notice in the new session: `Switched project to <path>`.
4. The old session simply ends (same as `/clear` semantics); nothing carries
   over.

## Error Handling

- Nonexistent path / not a directory: notice `Not a directory: <path>`, no
  state change.
- `process.chdir` failure (e.g. permissions): notice with the error message, no
  remount.
- Empty recent-projects list when opening the picker: notice `No recent
  projects.`

## Testing

Vitest unit tests:
- Path resolution: `~` expansion, relative → absolute, rejection of files and
  missing paths.
- Recent-project derivation: dedup of session index cwds, ordering (most recent
  first), current cwd handling.

Manual verification: run the TUI, `/set project <other repo>`, confirm status
bar cwd, git branch, skills, and permissions reflect the new project and a new
session started.

## Out of Scope

- Carrying conversation context across projects.
- Named/saved project registry.
- Other `/set` subcommands (the command is structured so they can be added
  later).
