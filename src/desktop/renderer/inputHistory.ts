// Desktop composer input history (Up/Down recall, TUI parity).
// Mirrors src/agent/history.ts semantics (cap 100, dedupe consecutive,
// cursor reset on submit) but persists to localStorage because the sandboxed
// renderer cannot touch history.json on disk. Kept window-free at module
// scope so node-based unit tests can import this directly (same pattern as
// themeState.ts / lastSelection.ts).

export const INPUT_HISTORY_STORAGE_KEY = "cloudcode.inputHistory";
export const MAX_INPUT_HISTORY = 100;

export interface HistoryNav {
  entries: string[];
  cursor: number;
  draft: string | undefined;
}

export function emptyHistoryNav(): HistoryNav {
  return { entries: [], cursor: 0, draft: undefined };
}

function normalizeEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

export function loadInputHistoryEntries(): string[] {
  try {
    const stored = globalThis.localStorage?.getItem(INPUT_HISTORY_STORAGE_KEY);
    if (stored === null || stored === undefined) return [];
    return normalizeEntries(JSON.parse(stored));
  } catch {
    return [];
  }
}

export function storeInputHistoryEntries(entries: string[]): void {
  try {
    globalThis.localStorage?.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage (private mode, quota) must never break the composer.
  }
}

// Appends a sent prompt; consecutive duplicates are ignored (same as the
// TUI History class). Returns the new list, capped to MAX_INPUT_HISTORY.
export function pushInputHistoryEntry(entries: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [...entries];
  if (entries[entries.length - 1] === trimmed) return [...entries];
  return [...entries, trimmed].slice(-MAX_INPUT_HISTORY);
}

// Up: stash the in-progress draft on first step, then walk backwards.
// Returns undefined when there is nothing older to show.
export function recallHistoryBack(nav: HistoryNav, currentInput: string): { text: string; nav: HistoryNav } | undefined {
  if (nav.entries.length === 0 || nav.cursor <= 0) return undefined;
  const draft = nav.draft === undefined ? currentInput : nav.draft;
  const cursor = nav.cursor - 1;
  return { text: nav.entries[cursor] ?? "", nav: { entries: nav.entries, cursor, draft } };
}

// Down: walk forward; stepping past the newest entry restores the stashed
// draft (or clears when there was none). Returns undefined when already at
// the live input so the caller can leave the textarea untouched.
export function recallHistoryForward(nav: HistoryNav): { text: string; nav: HistoryNav } | undefined {
  if (nav.cursor >= nav.entries.length) return undefined;
  const cursor = nav.cursor + 1;
  if (cursor >= nav.entries.length) {
    const text = nav.draft ?? "";
    return { text, nav: { entries: nav.entries, cursor, draft: undefined } };
  }
  return { text: nav.entries[cursor] ?? "", nav: { entries: nav.entries, cursor, draft: nav.draft } };
}

// Any manual edit abandons the in-progress recall: the draft is dropped and
// the cursor re-pins to the live input (past the newest entry).
export function resetHistoryNav(nav: HistoryNav): HistoryNav {
  return { entries: nav.entries, cursor: nav.entries.length, draft: undefined };
}

// True when Up/Down should recall history instead of moving the caret.
// Multi-line composers keep native caret motion inside the text: only the
// first line's Up and the last line's Down become history recall.
export function shouldRecallHistory(
  value: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  direction: "up" | "down"
): boolean {
  if (selectionStart === null || selectionStart === undefined) return true;
  if (selectionEnd === null || selectionEnd === undefined) return true;
  if (selectionStart !== selectionEnd) return false;
  const caret = selectionStart;
  if (direction === "up") {
    return value.lastIndexOf("\n", caret - 1) === -1;
  }
  const nextNewline = value.indexOf("\n", caret);
  return nextNewline === -1;
}
