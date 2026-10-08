# Desktop project menu bounds

## Plan

1. Match popup height to available viewport space and the placement estimate.
2. Keep keyboard-highlighted projects visible in the scrolling list.
3. Verify viewport geometry and the last option in an isolated Electron fixture.
4. Build and package the updated desktop renderer.

## Project removal

Add a per-project remove button to the popup. Removal forgets recent-project
and untitled-workspace navigation records, retaining project files and session
transcripts. Removing the active project selects the first remaining project.
Disable removal while that workspace has running turns. Errors are reported
at the UI action boundary. Test persistence after restart and native selection
fallback after removing the active project.

## Cause

Placement assumes a maximum height of 360 pixels, while CSS allows nearly
the full viewport height. A long list placed below the trigger consequently
extends below the window and clips its last options.

## Validation

- Four project-menu unit tests passed; desktop type checking and build passed.
- Isolated Electron fixture with 30 synthetic projects passed at viewport
  heights of 870 and 300 pixels. Popup bottoms were 510 and 292 pixels;
  the last option was fully visible after End-key navigation in both cases.
- Screenshot inspected at release/desktop-project-menu.png: the menu stays
  bounded and scrollable beneath the trigger.
- User project files and the running installed application were not changed.

## Final feature validation

- Version advanced to 0.1.152 across source, npm metadata, lockfile, and installer.
- Five focused test files passed (48 tests), including restart persistence
  after project removal, retained sessions, and retained member directories.
- Electron fixture verified 30-project bounds at two viewport heights and
  removal of the active project, selection fallback, and the updated 29-item
  list. Desktop build, type checking, lint, and diff checks passed.
- Removal buttons retain native Enter behavior when focused; list navigation
  does not intercept Enter on a removal button.
