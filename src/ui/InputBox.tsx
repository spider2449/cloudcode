import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { completions } from "../commands/registry.js";
import type { Command } from "../commands/types.js";
import type { History } from "../agent/history.js";

interface Props {
  registry: Map<string, Command>;
  onSubmit(text: string): void;
  disabled: boolean;
  history: History;
}

export function InputBox({ registry, onSubmit, disabled, history }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  // Terminals can deliver many keypresses in one stdin chunk (paste, fast
  // typing), so the handler may fire several times before React re-renders;
  // refs keep the authoritative state instead of a stale render closure.
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  // Draft saved when the user starts recalling history with the up arrow.
  const draftRef = useRef<string | undefined>(undefined);

  const update = (nextValue: string, nextCursor: number) => {
    valueRef.current = nextValue;
    cursorRef.current = Math.max(0, Math.min(nextCursor, nextValue.length));
    setValue(valueRef.current);
    setCursor(cursorRef.current);
  };

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

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl || key.meta) return;
    if (key.leftArrow) {
      update(valueRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      update(valueRef.current, cursorRef.current + 1);
      return;
    }
    if (key.upArrow) {
      if (draftRef.current === undefined) draftRef.current = valueRef.current;
      const recalled = history.back();
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
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
      const m = /^\/(\w*)$/.exec(valueRef.current);
      if (m) {
        const matches = completions(registry, m[1]);
        if (matches.length === 1) update(`/${matches[0]} `, matches[0].length + 2);
      }
      return;
    }
    if (key.return && !input) {
      submit();
      return;
    }
    // A chunk may mix text and line endings; split it so each line submits.
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        submit();
      } else if (ch >= " ") {
        const v = valueRef.current;
        const c = cursorRef.current;
        update(v.slice(0, c) + ch + v.slice(c), c + 1);
      }
    }
  });

  const slashMatch = /^\/(\w*)$/.exec(value);
  const hints = slashMatch ? completions(registry, slashMatch[1]) : [];
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{before}{disabled ? "" : "█"}{after}</Text>
      </Box>
      {disabled && <Text color="gray">working… (Esc to interrupt)</Text>}
      {!disabled && hints.length > 0 && (
        <Text color="gray">{hints.map(h => `/${h}`).join("  ")}</Text>
      )}
    </Box>
  );
}
