# nativeApp.ts split design

Date: 2026-08-23

## Goal

Bring `src/ui/nativeApp.ts` back under the ~600-line soft limit (currently 657)
by extracting three state owners, following the established pattern from the
earlier keyRouter / permissionController / appPickers / usageTracker splits:
each extraction moves *state ownership*, not just code.

## Extractions

### 1. `src/ui/imageAttachments.ts`

Owns: `pendingImages`, `attachSeq`.

API: `attachFromClipboard()`, `takeForSend(): Attachment[]`, `clear()`,
`get count(): number`.

Deps (constructor): input box reference for `attachmentCount` sync,
`notice(text)`, `recompute()`.

Removes from App: 4 members + `attachClipboardImage`/`clearPendingImages`.
`sendUserMessage` calls `takeForSend()`; Esc handling calls `clear()`.

### 2. `src/ui/inputQueue.ts`

Owns: `queuedMessages`.

API: `enqueue(text)`, `drainIfIdle(isIdle: () => boolean, submit: (t: string) => void)`,
`get size(): number`.

Preserves FIFO semantics including drain-after-slash-command behavior.

### 3. `src/ui/resizeGuard.ts`

Owns: `resizeRepaintTimer` and the debounce logic.

API: `handleResize()`, `dispose()`.

Deps: `isRunning()`, terminal, renderer, buffer, `recompute()`. Keeps the
documented resize semantics verbatim (immediate in-storm repaint, debounced
full scrollback-clearing reprint after 150 ms, inert after stop).

## Constraints

- No behavior change; all existing tests pass untouched except where they
  construct the moved pieces directly.
- Each new module gets a focused test file in the same commit.
- `npm run lint:size` must report nativeApp.ts under 600 lines afterwards.
