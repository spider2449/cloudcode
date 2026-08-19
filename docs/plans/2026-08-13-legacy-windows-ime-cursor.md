# Legacy Windows IME cursor compatibility

## Problem

Cloudcode now parks the terminal cursor at the input insertion point, which
anchors Chinese IME candidate windows correctly on current Windows versions.
Windows 10 1909 and earlier still fail to present the IME correctly while that
native cursor is hidden.

## Plan

1. Detect legacy Windows console builds (Windows 10 1909 / build 18363 and
   earlier) from the OS release string.
2. Keep the native terminal cursor visible at startup on those builds so the
   OS IME has a usable caret anchor; retain the current hidden cursor elsewhere.
3. Add boundary tests for Windows 10 1909, Windows 10 2004, newer Windows, and
   non-Windows platforms.
4. Run lint, size checks, build, and the full test suite.
5. Do not paint the synthetic block marker under the visible native cursor on
   legacy Windows. Reserve the same display cell with a blank so wrapping and
   the IME anchor remain unchanged without the two cursors visually cancelling
   each other.
