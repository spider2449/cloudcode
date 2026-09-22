# Project dropdown readability

## Scope

Replace the desktop sidebar's native project `<select>` with a themed,
keyboard-accessible menu so Windows does not render an unreadable system popup.

## Implementation

- Add a focused project menu component with selected-state styling, hover, and
  Arrow/Home/End/Enter/Escape behavior.
- Render the popup above the sidebar overflow boundary and keep its position
  anchored to the project switcher.
- Preserve the existing project-switch callback and add focused navigation
  tests.

## Verification

- Run the focused project-menu tests.
- Run desktop typechecking, lint, and the desktop renderer build.
- Inspect the final diff and working-tree scope.
