# Hide the desktop backend console on Windows

## Scope

Stop the Electron desktop backend's `node.exe` child from opening a visible
Windows console window. Keep the backend's existing stdin/stdout IPC behavior
unchanged.

## Plan

1. Add the Windows-specific `windowsHide: true` spawn option in the Electron
   shell when it starts the GUI backend.
2. Add a source-level regression assertion covering the option.
3. Run the focused desktop tests, desktop typecheck, and lint.

## Non-goals

- Do not change the terminal CLI or user-launched shell commands.
- Do not change package versions or release artifacts.
