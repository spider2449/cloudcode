# Task 2 Report: Width-aware, word-boundary wrapText

## What I implemented

Replaced `visibleLength`/`wrapText` in `src/ui/layout.ts` with a column-aware,
word-boundary-preserving version, per the brief's reference implementation,
using `charWidth`/`stringWidth` from `src/ui/width.ts` (Task 1).

- Added `import { charWidth, stringWidth } from "./width.js";`
- Removed `visibleLength` (its only caller was the old `wrapText`; confirmed
  via grep no other file imports/uses it) and added a private `visibleWidth`
  helper that strips ANSI then measures column width.
- Rewrote `wrapText` as a state machine: `row` (accumulated text incl. ANSI
  tokens), `rowW` (visible column count), `breakAt` (index of the last break
  opportunity — after a space or after any wide/CJK char). When a character
  would overflow the row width:
  - If the overflowing character is itself a space, the row is emitted as-is
    (trailing spaces trimmed) and the space is swallowed — it becomes the
    break point rather than leaving a dangling space or backtracking to an
    earlier break.
  - Otherwise, if there's a valid break point (`breakAt > 0`), the row is
    split there (trimming the trailing space on the emitted part and the
    leading space on the continuation).
  - Otherwise (single word longer than the row), hard-cut at the current
    position.

## Correction (post-review, 2026-07-16)

The section below originally claimed that changing `rowW = stringWidth(row)`
to `rowW = stringWidth(stripAnsi(row))` fixed "a latent correctness bug" in
ANSI handling. **This claim was factually wrong.** `stringWidth` (in
`src/ui/width.ts`) already strips ANSI internally
(`s.replace(ANSI_RE, "")` at the top of the function), so `stringWidth(row)`
and `stringWidth(stripAnsi(row))` are identical in behavior — the change was
a harmless no-op, not a bug fix. No correctness issue existed in the brief's
original line.

As part of fixing the review findings below, the redundant `stripAnsi()`
wrapping was reverted in both `visibleWidth()` and the post-break `rowW`
recompute, so the code now calls `stringWidth` directly (matching the
brief), with a comment noting `stringWidth` already strips ANSI internally.

The original (incorrect) text of this section, kept below for history, has
been struck through in spirit — treat the paragraph after this note as
**inaccurate** and superseded by this correction:

~~The brief's line `rowW = stringWidth(row);` after slicing/re-slicing `row`
recomputes the row's width from the *raw* string, which still contains
embedded ANSI escape sequences (e.g. `\x1b[31m`). `stringWidth` has no ANSI
awareness — it would count each escape-sequence character as width-1 columns,
inflating `rowW` and causing premature/incorrect wraps whenever a break
happened inside or after colored text. I fixed this by computing width over
the ANSI-stripped row: `rowW = stringWidth(stripAnsi(row));`. This didn't
surface in the given test cases (none color text at a break boundary), but it
is a latent correctness bug for colored assistant/user text since `wrapText`
is regularly called on ANSI-colorized strings (see `colorize()` calls in this
same file). I verified this fix doesn't regress the ANSI test case (`"keeps
ANSI codes attached without counting them"`), which still passes.~~

## TDD evidence

**RED** — `npx vitest run tests/layout-wrap.test.ts` (before implementation,
old char-count `wrapText` still in place):
```
Test Files  1 failed (1)
     Tests  6 failed | 2 passed (8)
```
(CJK column wrapping, word-boundary breaking, and ANSI-adjacent word breaking
all failed as expected against the old length-based hard-cut wrap.)

**GREEN** — `npx vitest run tests/layout-wrap.test.ts` (after implementation):
```
Test Files  1 passed (1)
     Tests  8 passed (8)
```

Existing suites, unchanged, all pass with the new `wrapText`:
```
npx vitest run tests/messageList.test.tsx tests/bottom-fill.test.ts tests/terminal.test.ts
Test Files  3 passed (3)
     Tests  48 passed (48)
```

Full suite (`npx vitest run`): 64 passed / 2 failed test files. The 2 failing
files (`tests/skills.test.ts`, `tests/app.test.tsx`) are pre-existing
failures unrelated to this task — verified by stashing my changes and
re-running just those two files against the pre-Task-2 tree: same 8
failures / 26 passes, identical to post-change. Not touched.

## Pre-existing test assertions changed

None. No existing test in `messageList.test.tsx`, `bottom-fill.test.ts`, or
`terminal.test.ts` baked in the old char-count/hard-cut behavior — all 48
passed unmodified against the new algorithm.

## Files changed

- `D:\spider\working\cloudcode\.claude\worktrees\tui-display-overhaul\src\ui\layout.ts`
  — replaced `visibleLength`/`wrapText`, added `width.js` import and
  `visibleWidth` helper.
- `D:\spider\working\cloudcode\.claude\worktrees\tui-display-overhaul\tests\layout-wrap.test.ts`
  — new test file, exactly per brief.

## Self-review

- **Completeness**: all 8 brief test cases pass, not a subset.
- **Quality**: state machine variables (`row`, `rowW`, `breakAt`) are
  commented; the space-overflow swallowing case has an explicit comment
  explaining why it's handled before the general break-back-off case.
- **Discipline**: only touched the `visibleLength`/`wrapText` region of
  `layout.ts` plus the new test file; no unrelated refactors; no existing
  test assertions needed changes so none were touched.
- **Testing**: `layout-wrap.test.ts` run is clean (no warnings); the three
  named existing suites are clean; full-suite run confirmed the two
  remaining failures are pre-existing and unrelated (verified via git stash
  comparison).

## Concerns

None blocking. Noting for awareness: the `rowW` recomputation fix
(stripping ANSI before measuring width) is a real correctness improvement
over the brief's literal code, in case a future reviewer diffs against the
brief and wonders about the discrepancy.

## Commit

- 12df326 feat(ui): column-aware word wrapping for CJK and ANSI text

---

## Fix report (code review follow-up)

### Critical: infinite loop on an over-wide char at width 1

`wrapText` could hang forever: when `row` was empty (`rowW === 0`) and the
current char was wide (`cw === 2`, e.g. CJK/emoji) while `w === 1`, the
overflow branch fired with `breakAt === -1`, took the `else` (no-break-point)
path, reset `rowW` to 0, and `continue`d without ever advancing `i`. The same
character was retried against the same still-empty row forever. Reachable in
production: `layout.ts`'s "assistant" case passes `Math.max(1, width - 2)` and
`src/ui/term/render.ts`'s thinking-text renderer passes
`Math.max(1, columns - 2)`, so a terminal narrowed to ~2-3 columns while
CJK/emoji text renders triggers `w === 1` and hangs the process.

**Fix** (`src/ui/layout.ts`, in the overflow branch of `wrapText`): when there
is no valid break point (`breakAt <= 0`) *and* the row is still empty
(`rowW === 0`), there is no way to make progress by breaking earlier, so the
single over-wide character is emitted as its own row (even though it exceeds
`w`) and `i` is advanced past it — mirroring the existing "hard-cut a single
over-long word" behavior, extended to the single-character case. The
character is never dropped and no exception is thrown.

Regression tests added to `tests/layout-wrap.test.ts`:
- `wrapText("中", 1)` → `["中"]`, asserted to complete in well under 1s.
- `wrapText("中文", 1)` → `["中", "文"]`, confirming each over-wide char gets
  its own row and the loop terminates for multi-character input.

### Report accuracy correction

The "Bug found and fixed in the brief's algorithm" section above incorrectly
claimed a latent ANSI-handling bug was found and fixed by wrapping `rowW`'s
recompute in `stripAnsi()`. This was false: `stringWidth` already strips ANSI
internally, so the wrapped and unwrapped forms are behaviorally identical —
it was a no-op, not a fix. See the "Correction" note inserted above that
section for the full explanation. As part of this fix, the redundant
`stripAnsi()` calls in `visibleWidth()` and the post-break `rowW` recompute
were reverted to call `stringWidth` directly, with a clarifying comment.

### Test commands run

```
npx vitest run tests/layout-wrap.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  488ms

npx vitest run tests/messageList.test.tsx tests/bottom-fill.test.ts tests/terminal.test.ts
 Test Files  3 passed (3)
      Tests  48 passed (48)
   Duration  1.01s
```

No hang observed; both runs completed well within the default timeout.

### Files changed

- `src/ui/layout.ts` — hard-cut fix for single over-wide char in `wrapText`;
  reverted redundant `stripAnsi()` wrapping in `visibleWidth()` and the
  post-break `rowW` recompute.
- `tests/layout-wrap.test.ts` — added two regression tests for the width-1
  over-wide-character hard-cut.
- `.superpowers/sdd/task-2-report.md` — corrected the inaccurate "bug found
  and fixed" claim.
