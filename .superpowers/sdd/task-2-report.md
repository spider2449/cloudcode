# Task 2 Report: Render Queued Messages Above Input Box

## Summary

Successfully implemented Task 2: rendering queued messages above the input box with proper width truncation and muted color formatting. The implementation adds the infrastructure for displaying queued messages while streaming (actual queueing logic deferred to Task 3).

## What Was Implemented

### 1. Interface Extension (`src/ui/term/render.ts`)
- Added `queuedRows: string[]` field to `BottomState` interface (lines 34-36)
- Added comment documenting that rows are muted, width-truncated, and placed directly above the input divider
- Modified `frame()` method to unshift queued rows above the input box when overlay is not active (line 84)

### 2. App State Management (`src/ui/nativeApp.ts`)
- Added imports: `sgr`, `SGR_RESET` from `./term/ansi.js` and `truncateToWidth` from `./width.js` (lines 26-27)
- Added `private queuedMessages: string[] = []` field to App class (lines 75-77) for FIFO queue of messages submitted during streaming
- Modified `recompute()` method to:
  - Build `queuedRows` from `queuedMessages` by mapping each message through truncation and color formatting
  - Convert newlines to spaces for single-row display
  - Apply muted color code from theme (with reset after)
  - Pass `queuedRows` to `BottomState` (lines 551-557)

### 3. Test Infrastructure (`tests/render.test.ts`)
- Updated `baseBottom()` helper to include `queuedRows: []` in default state (line 20)
- Added test: "renders queuedRows above the input box rows" verifying:
  - Queued rows appear in frame output
  - Queued rows are positioned BEFORE the input box border rows (earlier in footer paint)

## TDD Evidence

### RED (Failing Test)
```bash
npx vitest run tests/render.test.ts
```

**Output (before implementation):**
- Test: "renders queuedRows above the input box rows" - FAILED
- Error: `queuedRows` field unknown on `BottomState`
- Test assertion: expected output to contain "⧉ queued: fix tests" - FAILED

### GREEN (Passing Test)
```bash
npx vitest run tests/render.test.ts
```

**Output (after implementation):**
- Test: "renders queuedRows above the input box rows" - PASSED ✓
- 51 tests passed in render.test.ts (was 50 before adding queuedRows test)
- Only pre-existing failure: "prefixes the thinking preview..." (due to uncommitted theme.ts change)

**Full test suite:**
```bash
npm test
```
- Tests: 1205 passed | 16 failed
- Test Files: 138 passed | 4 failed
- No new failures introduced by Task 2 changes

## Files Changed

1. **src/ui/term/render.ts**
   - Added `queuedRows: string[]` field to `BottomState` interface
   - Integrated queued rows into footer rendering pipeline

2. **src/ui/nativeApp.ts**
   - Added imports for color/truncation utilities
   - Added `queuedMessages` field to App class
   - Extended `recompute()` to build and pass queued rows with proper formatting

3. **tests/render.test.ts**
   - Updated `baseBottom()` helper with `queuedRows: []` default
   - Added new test for queued rows rendering

## Self-Review Findings

### Implementation Quality
- ✓ All code comments in English as per project standards
- ✓ Queued rows go through `truncateToWidth()` - prevents over-width rows per conhost limitation
- ✓ Muted color applied via `sgr(this.theme.muted)` with proper reset
- ✓ Newlines replaced with spaces for single-row display
- ✓ FIFO queue pattern ready for Task 3 (one message per turn when agent returns to idle)

### Architecture
- ✓ Clean separation: `queuedMessages` on App, `queuedRows` on BottomState (pre-rendered, pre-colored)
- ✓ Test helper updated to support required field everywhere
- ✓ Footer assembly order correct: queued rows above input box (after border unshift)

### No Concerns
- Theme.ts pre-existing change left untouched as instructed
- No TypeScript compilation errors
- All new tests passing, no regressions introduced

## Commit

```
a81d9c7 feat(ui): render queued messages above the input divider
```

Files committed:
- src/ui/term/render.ts
- src/ui/nativeApp.ts
- tests/render.test.ts
