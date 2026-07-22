# Task 2 Report: Delete the legacy Ink TUI component tree

## Step 1: Verification of ambiguous test files

```
$ head -5 tests/app.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../src/ui/nativeApp.js";
import { FakeTerminal } from "../src/ui/term/terminal.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";
```
Imports `App` from `../src/ui/nativeApp.js` — the **native** TUI, not Ink. **Not deleted**, per brief instructions.

```
$ head -5 tests/inputBox-width.test.ts
import { describe, it, expect } from "vitest";
import { InputBox } from "../src/ui/widgets/inputBox.js";
import { History } from "../src/agent/history.js";
import { stringWidth } from "../src/ui/width.js";
```
Imports `InputBox` from `../src/ui/widgets/inputBox.js` — the **native** widget, not the Ink `src/ui/InputBox.tsx`. **Not deleted**, per brief instructions.

Both ambiguous files were confirmed as native-side tests and were correctly excluded from the delete list; no `git rm` was run on either.

## Step 2: Baseline (before deletion)

```
$ npx vitest run
 Test Files  1 failed | 74 passed (75)
      Tests  1 failed | 656 passed (657)
```
The single failure was in `tests/app.test.tsx:304` (the pre-existing flaky Ink `App` test, expected per the brief — this file is in the delete list).

## Step 3: Deletion

Ran the two `git rm` commands from the brief exactly as written (excluding the two ambiguous files, which were skipped since Step 1 showed they belong to the native stack):

```
git rm src/ui/App.tsx src/ui/PermissionDialog.tsx src/ui/InputBox.tsx src/ui/MemoryPicker.tsx src/ui/MessageList.tsx src/ui/ProgressBar.tsx src/ui/ProjectPicker.tsx src/ui/ResumePicker.tsx src/ui/StatusBar.tsx src/ui/SuggestionMenu.tsx src/ui/WorkingIndicator.tsx src/ui/ThemeContext.tsx src/ui/bottomFill.ts
git rm tests/app.test.tsx tests/inputBox.test.tsx tests/messageList.test.tsx tests/permissionDialog.test.tsx tests/projectPicker.test.tsx tests/resumePicker.test.tsx tests/statusBar.test.tsx tests/suggestionMenu.test.tsx tests/workingIndicator.test.tsx tests/memoryPicker.test.tsx tests/bottom-fill.test.ts tests/useGitStatus.test.tsx
```

## Step 4: Build — discrepancy found and resolved

`npm run build` initially failed with errors **not** limited to `useGitStatus.ts`:

```
src/ui/nativeApp.ts(32,36): error TS2307: Cannot find module './MemoryPicker.js' or its corresponding type declarations.
src/ui/widgets/overlay.ts(8,35): error TS2307: Cannot find module '../MemoryPicker.js' or its corresponding type declarations.
```

Per the brief's instruction to re-verify with grep rather than force-deleting further, I inspected `src/ui/MemoryPicker.tsx` (via `git show HEAD:...`) and found it was **not Ink-only**: alongside the Ink `MemoryPicker` component it also exported `MemoryOption` (a plain type) and `buildMemoryOptions` (a plain function with no Ink/React dependency), both of which are consumed by the native TUI (`nativeApp.ts` line 32, `widgets/overlay.ts` line 8).

I also checked the corresponding test, `tests/memoryPicker.test.tsx`, and found it exclusively exercises `buildMemoryOptions` — it contains no Ink/React usage at all.

Resolution (keep-and-trim, not full deletion, matching the brief's escalation guidance):
- Restored `src/ui/MemoryPicker.tsx` and `tests/memoryPicker.test.tsx` with `git checkout HEAD -- <path>`.
- Edited `src/ui/MemoryPicker.tsx` to remove only the Ink-specific parts: the `React`/`ink` imports, the `useTheme` import from the now-deleted `ThemeContext.js`, the `Props` interface, and the `MemoryPicker` JSX component itself. Kept `MemoryOption` and `buildMemoryOptions` untouched (added a short comment noting why the file still exists and that the Ink component was removed).
- Left `tests/memoryPicker.test.tsx` untouched (it never imported the Ink component).

After this fix, `npm run build` passed with **zero errors** (including inside `useGitStatus.ts` — it did not surface any error in this build, so there was nothing further to confirm as expected beyond the MemoryPicker case).

## Step 5: Full suite (after deletion)

```
$ npx vitest run
 Test Files  64 passed (64)
      Tests  547 passed (547)
```

Compared to the Step 2 baseline (75 files / 657 tests, 1 failing file/test):
- 11 test files removed: `app.test.tsx`, `inputBox.test.tsx`, `messageList.test.tsx`, `permissionDialog.test.tsx`, `projectPicker.test.tsx`, `resumePicker.test.tsx`, `statusBar.test.tsx`, `suggestionMenu.test.tsx`, `workingIndicator.test.tsx`, `bottom-fill.test.ts`, `useGitStatus.test.tsx` — matches 75 − 11 = 64.
- The previously-failing flaky Ink `app.test.tsx` test is gone along with it.
- No new failures in any surviving test, including the retained `tests/app.test.ts` (native `App`), `tests/inputBox-width.test.ts` (native `InputBox`), and `tests/memoryPicker.test.tsx` (`buildMemoryOptions`).

## Files actually deleted

- `src/ui/App.tsx`
- `src/ui/PermissionDialog.tsx`
- `src/ui/InputBox.tsx`
- `src/ui/MessageList.tsx`
- `src/ui/ProgressBar.tsx`
- `src/ui/ProjectPicker.tsx`
- `src/ui/ResumePicker.tsx`
- `src/ui/StatusBar.tsx`
- `src/ui/SuggestionMenu.tsx`
- `src/ui/WorkingIndicator.tsx`
- `src/ui/ThemeContext.tsx`
- `src/ui/bottomFill.ts`
- `tests/app.test.tsx`
- `tests/inputBox.test.tsx`
- `tests/messageList.test.tsx`
- `tests/permissionDialog.test.tsx`
- `tests/projectPicker.test.tsx`
- `tests/resumePicker.test.tsx`
- `tests/statusBar.test.tsx`
- `tests/suggestionMenu.test.tsx`
- `tests/workingIndicator.test.tsx`
- `tests/bottom-fill.test.ts`
- `tests/useGitStatus.test.tsx`

## Files NOT deleted (deviating from the brief's literal delete list, with justification)

- `tests/app.test.ts` — confirmed in Step 1 to test the native `App` (`nativeApp.js`), not Ink. Excluded correctly per the brief's own instructions.
- `tests/inputBox-width.test.ts` — confirmed in Step 1 to test the native `InputBox` (`widgets/inputBox.js`), not Ink. Excluded correctly per the brief's own instructions.
- `src/ui/MemoryPicker.tsx` — was in the brief's delete list but discovered during Step 4 to be misclassified: it contains shared, non-Ink logic (`MemoryOption`, `buildMemoryOptions`) still consumed by `nativeApp.ts` and `widgets/overlay.ts`. Kept, with only the Ink-specific `MemoryPicker` component and its imports removed.
- `tests/memoryPicker.test.tsx` — was in the brief's delete list but discovered to test only `buildMemoryOptions` (no Ink usage). Kept unmodified.

## Concerns for the plan owner

The brief classified `src/ui/MemoryPicker.tsx` as Ink-only and unreferenced by the native TUI, but this was inaccurate — `buildMemoryOptions`/`MemoryOption` from that same file **are** referenced by `nativeApp.ts` and `widgets/overlay.ts`. This is a genuine discrepancy in the brief's file classification, resolved per the brief's own Step 4 guidance ("keep it and remove only the specific import") rather than force-deleting further files. Task 3/4 owners should be aware `src/ui/MemoryPicker.tsx` still exists post-Task-2, now containing only plain TS helpers (`MemoryOption`, `buildMemoryOptions`) with no Ink/React dependency — it is not part of the remaining Ink surface and should not be targeted for deletion by later cleanup tasks.
