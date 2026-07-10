import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { completions } from "../commands/registry.js";
import type { Command } from "../commands/types.js";

interface Props {
  registry: Map<string, Command>;
  onSubmit(text: string): void;
  disabled: boolean;
}

export function InputBox({ registry, onSubmit, disabled }: Props) {
  const [value, setValue] = useState("");
  // Terminals can deliver many keypresses in one stdin chunk (paste, fast
  // typing), so the handler may fire several times before React re-renders;
  // a ref keeps the authoritative value instead of a stale render closure.
  const valueRef = useRef("");

  const update = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  const submit = () => {
    const text = valueRef.current.trim();
    update("");
    if (text) onSubmit(text);
  };

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      update(valueRef.current.slice(0, -1));
      return;
    }
    if (key.tab) {
      const m = /^\/(\w*)$/.exec(valueRef.current);
      if (m) {
        const matches = completions(registry, m[1]);
        if (matches.length === 1) update(`/${matches[0]} `);
      }
      return;
    }
    if (key.return && !input) {
      submit();
      return;
    }
    // A chunk may mix text and line endings; split it so each line submits.
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") submit();
      else if (ch >= " ") update(valueRef.current + ch);
    }
  });

  const slashMatch = /^\/(\w*)$/.exec(value);
  const hints = slashMatch ? completions(registry, slashMatch[1]) : [];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{value}{disabled ? "" : "█"}</Text>
      </Box>
      {disabled && <Text color="gray">working… (Esc to interrupt)</Text>}
      {!disabled && hints.length > 0 && (
        <Text color="gray">{hints.map(h => `/${h}`).join("  ")}</Text>
      )}
    </Box>
  );
}
