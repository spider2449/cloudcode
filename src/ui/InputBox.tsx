import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getSuggestions, applySuggestion, type CompletionContext, type Suggestion } from "../commands/completion.js";
import { SuggestionMenu, MAX_ROWS } from "./SuggestionMenu.js";
import type { History } from "../agent/history.js";
import { useTheme } from "./ThemeContext.js";
import { inputBoxRows } from "./bottomFill.js";

interface Props {
  completionCtx: CompletionContext;
  onSubmit(text: string): void;
  disabled: boolean;
  history: History;
  // Current terminal column count, needed to compute exactly how many rows
  // the bordered input box wraps to (see onInputRowsChange below). Optional
  // with an 80-column fallback so call sites that don't care about the
  // exact live-region floor (e.g. most existing tests) don't need to wire
  // it through.
  columns?: number;
  // Reports the currently rendered suggestion-menu row count (0 when
  // closed/suppressed) so App.tsx's live-region floor can account for it
  // without a fixed worst-case guess. Called from inside the same stdin
  // 'input' event handler that updates this component's own state; Ink
  // wraps each useInput handler in reconciler.batchedUpdates (see
  // ink/build/hooks/use-input.js), so this update and InputBox's local
  // setState calls land in the SAME React commit — no one-frame lag, unlike
  // measureElement which only reports the previous frame's height.
  onMenuRowsChange?: (rows: number) => void;
  // Reports InputBox's own exact rendered row count (border + wrapped
  // value), same-batch as onMenuRowsChange above, so a long typed/pasted
  // line or a backtick-continuation newline that grows the box past its
  // baseline 3 rows is never underestimated by App.tsx's live-region floor.
  onInputRowsChange?: (rows: number) => void;
}

export function InputBox({ completionCtx, onSubmit, disabled, history, columns = 80, onMenuRowsChange, onInputRowsChange }: Props) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  // Suggestion list rendered in JSX; updated ONLY through sync() below (the
  // same function that reports menuRows to App.tsx), never recomputed
  // independently at render time from the live, mutable completionCtx. That
  // would let the render output drift from what was last reported to
  // App.tsx's live-region floor on a frame where no input event ran (e.g.
  // App's elapsed-timer re-render, or an async update to availableModels()/
  // registry) — the same overflow failure mode as unmodeled input growth.
  //
  // Accepted trade-off (reviewed, not an oversight): if the menu is opened
  // before FileIndex/fetchModels finish loading, it shows 0 rows and only
  // picks up the newly-arrived data on the user's NEXT keystroke, not the
  // instant it arrives — there is no completion callback wired from those
  // async sources into sync(). Do not "fix" this by recomputing suggestions
  // at render time; that reintroduces the overflow this closes.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Terminals can deliver many keypresses in one stdin chunk (paste, fast
  // typing), so the handler may fire several times before React re-renders;
  // refs keep the authoritative state instead of a stale render closure.
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  // Draft saved when the user starts recalling history with the up arrow.
  const draftRef = useRef<string | undefined>(undefined);
  const suppressedRef = useRef(false);
  const selectedRef = useRef(0);
  const hadAtTokenRef = useRef(false);

  const currentSuggestions = (): Suggestion[] => {
    if (suppressedRef.current) return [];
    return getSuggestions(valueRef.current, cursorRef.current, completionCtx);
  };

  // Exact rendered row count of the bordered input box for the CURRENT ref
  // state, mirroring the JSX below ("> " + before-cursor + cursor-glyph +
  // after-cursor) exactly so a wrapped long line or a backtick-continuation
  // newline is counted precisely.
  const currentInputRows = (): number => {
    const before = valueRef.current.slice(0, cursorRef.current);
    const after = valueRef.current.slice(cursorRef.current);
    const content = "> " + before + (disabled ? "" : "█") + after;
    return inputBoxRows(content, columns);
  };

  // Single source of truth for everything App.tsx's live-region floor needs
  // from this component: the rendered suggestion list (also what JSX below
  // renders — see the `suggestions` state comment) and the exact row counts
  // reported up via onMenuRowsChange/onInputRowsChange. Always called from
  // inside the same synchronous stdin-event handler that updates this
  // component's own state (or from the mount/columns/disabled effect below),
  // so App.tsx's setState calls land in the same React commit as this
  // component's — no one-frame lag, unlike measureElement.
  const sync = () => {
    const s = currentSuggestions();
    setSuggestions(s);
    onMenuRowsChange?.(Math.min(s.length, MAX_ROWS));
    onInputRowsChange?.(currentInputRows());
  };

  const update = (nextValue: string, nextCursor: number) => {
    const changed = nextValue !== valueRef.current;
    valueRef.current = nextValue;
    cursorRef.current = Math.max(0, Math.min(nextCursor, nextValue.length));
    if (changed) {
      suppressedRef.current = false;
      selectedRef.current = 0;
      // Refresh the file cache when a new @-completion session starts.
      const hasAt = /(^|\s)@[\w./-]*$/.test(nextValue.slice(0, cursorRef.current));
      if (hasAt && !hadAtTokenRef.current) completionCtx.refreshFiles?.();
      hadAtTokenRef.current = hasAt;
    }
    setValue(valueRef.current);
    setCursor(cursorRef.current);
    setSelected(selectedRef.current);
    sync();
  };

  // Re-sync on mount (so a remounted InputBox — e.g. after a permission
  // overlay closes, see Finding 3 — reports its true, empty-value state
  // instead of leaving App.tsx's stale menuRows/inputRows from before the
  // remount) and whenever `columns` or `disabled` change, since both affect
  // currentInputRows()'s wrap math but neither is driven by a keystroke
  // (e.g. a terminal resize while a long line is already typed). This is a
  // useEffect, so it runs one tick after the render that changed columns/
  // disabled — the same catch-up timing as App.tsx's own measureElement
  // effect, not the zero-lag same-batch guarantee `update()` gets from
  // stdin events. Typing-driven growth (this task's actual repro) stays
  // zero-lag via update()/sync() above.
  useEffect(() => {
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, disabled]);

  const submit = () => {
    const current = valueRef.current;
    if (current.endsWith("\\")) {
      // Line continuation: swap the trailing backslash for a newline.
      update(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    update("", 0);
    draftRef.current = undefined;
    history.resetCursor();
    if (text) {
      history.add(text);
      onSubmit(text);
    }
  };

  const accept = (suggestions: ReturnType<typeof currentSuggestions>) => {
    const s = suggestions[Math.min(selectedRef.current, suggestions.length - 1)];
    const r = applySuggestion(valueRef.current, s);
    update(r.text, r.cursor);
  };

  // True when accepting the selected suggestion would leave the input as-is
  // (the value is already fully typed); Enter should submit, not re-accept.
  const acceptIsNoop = (suggestions: ReturnType<typeof currentSuggestions>) => {
    const s = suggestions[Math.min(selectedRef.current, suggestions.length - 1)];
    return applySuggestion(valueRef.current, s).text === valueRef.current.trimEnd();
  };

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl || key.meta) return;
    const menu = currentSuggestions();
    const menuOpen = menu.length > 0;
    if (key.escape && menuOpen) {
      suppressedRef.current = true;
      sync();
      return;
    }
    if (key.leftArrow) {
      update(valueRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      update(valueRef.current, cursorRef.current + 1);
      return;
    }
    if (key.upArrow) {
      if (menuOpen) {
        selectedRef.current = (selectedRef.current - 1 + menu.length) % menu.length;
        setSelected(selectedRef.current);
        return;
      }
      if (draftRef.current === undefined) draftRef.current = valueRef.current;
      const recalled = history.back();
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
      if (menuOpen) {
        selectedRef.current = (selectedRef.current + 1) % menu.length;
        setSelected(selectedRef.current);
        return;
      }
      const recalled = history.forward();
      if (recalled !== undefined) {
        update(recalled, recalled.length);
      } else {
        update(draftRef.current ?? "", (draftRef.current ?? "").length);
        draftRef.current = undefined;
      }
      return;
    }
    if (key.backspace || key.delete) {
      const v = valueRef.current;
      const c = cursorRef.current;
      if (c > 0) update(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }
    if (key.tab) {
      if (menuOpen) accept(menu);
      return;
    }
    if (key.return && !input) {
      if (menuOpen && !acceptIsNoop(menu)) accept(menu);
      else submit();
      return;
    }
    // A chunk may mix text and line endings; split it so each line submits.
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        const m = currentSuggestions();
        if (m.length > 0 && !acceptIsNoop(m)) accept(m);
        else submit();
      } else if (ch >= " ") {
        const v = valueRef.current;
        const c = cursorRef.current;
        update(v.slice(0, c) + ch + v.slice(c), c + 1);
      }
    }
  });

  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{before}{disabled ? "" : "█"}{after}</Text>
      </Box>
      {disabled && <Text color={theme.muted}>working… (Esc to interrupt)</Text>}
      {!disabled && suggestions.length > 0 && (
        <SuggestionMenu suggestions={suggestions} selected={Math.min(selected, suggestions.length - 1)} />
      )}
    </Box>
  );
}
