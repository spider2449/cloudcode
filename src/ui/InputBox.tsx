import React, { useState } from "react";
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

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const text = value.trim();
      setValue("");
      if (text) onSubmit(text);
    } else if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
    } else if (key.tab) {
      const m = /^\/(\w*)$/.exec(value);
      if (m) {
        const matches = completions(registry, m[1]);
        if (matches.length === 1) setValue(`/${matches[0]} `);
      }
    } else if (input && !key.ctrl && !key.meta) {
      setValue(v => v + input);
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
