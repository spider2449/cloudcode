# Themed desktop title bar

## Goal

Make the native Electron title bar and application menu follow the desktop theme instead of remaining light for every theme.

## Scope

- Keep the native window frame and native menu behavior.
- Synchronize Electron's native theme source with the renderer's resolved GUI theme.
- Default the shell to dark before the renderer loads, then update it for the light theme or a theme switch.
- Add regression coverage for the renderer-to-shell theme synchronization contract.

## Verification

- Run the focused desktop theme tests.
- Run desktop typecheck and lint.
- Inspect the final diff and working-tree scope.
