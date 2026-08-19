# Legacy Windows dark-theme cursor visibility

## Problem

Windows 10 1909 needs the native terminal cursor to remain visible so Chinese
IME composition and candidate UI can attach to the input position. The native
cursor can render black in a dark terminal theme, while the prior workaround
also removed cloudcode's synthetic marker, leaving no visible insertion point.

## Plan

1. Keep the native cursor visible on legacy Windows, but request a steady bar
   shape so it cannot cover the entire synthetic marker cell.
2. Render cloudcode's synthetic block marker on every platform, including when
   the legacy native cursor is visible.
3. Restore the user's default cursor shape when cloudcode exits.
4. Add focused ANSI, terminal lifecycle, input-box, and app regression tests.
5. Run lint, size checks, build, and the full test suite.
