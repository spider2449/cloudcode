# IME candidate cursor alignment

## Problem

The input box draws a block cursor as text, while the terminal's real cursor
remains hidden and parked at the end of the status bar. Windows IMEs anchor
their candidate window to that real cursor, so candidates appear below the
input instead of beside the insertion point.

## Plan

1. Have `InputBox.render()` report the rendered row and display column of its
   insertion marker, including wrapping, newlines, and wide CJK characters.
2. Preserve that anchor while the renderer assembles and caps the footer.
3. End both scroll-region and Windows simple-mode frames with the real cursor
   positioned on the input marker. Keep the cursor hidden so the existing
   visual block remains unchanged.
4. Account for the new parked row when simple mode erases or finalizes its
   prior footer.
5. Add focused input and renderer regression tests, then run the full project
   checks.

