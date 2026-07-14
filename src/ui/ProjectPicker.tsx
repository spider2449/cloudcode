import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./ThemeContext.js";
import { visibleWindow, MAX_ROWS } from "./SuggestionMenu.js";

interface Props {
  projects: string[];
  currentCwd: string;
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ projects, currentCwd, onPick, onCancel }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");

  const filtered = text
    ? projects.filter(p => p.toLowerCase().includes(text.toLowerCase()))
    : projects;
  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) { setIndex(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIndex(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return) {
      const picked = filtered[clampedIndex];
      if (picked) {
        if (picked === currentCwd) onCancel();
        else onPick(picked);
      } else if (text) {
        onPick(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setText(t => t.slice(0, -1));
      setIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText(t => t + input);
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.warning}>Switch project (type a path, ↑/↓ to pick recent, Enter, Esc)</Text>
      <Text>{"> "}{text}<Text inverse> </Text></Text>
      {filtered.length === 0 ? (
        <Text color={theme.muted}>
          {projects.length === 0 ? "No recent projects." : "No matches."} Press Enter to use the typed path.
        </Text>
      ) : (
        (() => {
          // Cap visible rows to MAX_ROWS regardless of entry count — see
          // ResumePicker.tsx for why (mirrors SuggestionMenu.tsx's windowing).
          const { start, end } = visibleWindow(filtered.length, clampedIndex, MAX_ROWS);
          return filtered.slice(start, end).map((p, i) => {
            const idx = start + i;
            return (
              <Text key={p} inverse={idx === clampedIndex}>
                {p === currentCwd ? "● " : "  "}{p}
              </Text>
            );
          });
        })()
      )}
    </Box>
  );
}
