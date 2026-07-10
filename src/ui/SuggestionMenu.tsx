import React from "react";
import { Box, Text } from "ink";
import type { Suggestion } from "../commands/completion.js";
import { useTheme } from "./ThemeContext.js";

const MAX_ROWS = 8;

export function visibleWindow(count: number, selected: number, max = MAX_ROWS): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - max + 1), count - max);
  return { start, end: start + max };
}

interface Props {
  suggestions: Suggestion[];
  selected: number;
}

export function SuggestionMenu({ suggestions, selected }: Props) {
  const theme = useTheme();
  const { start, end } = visibleWindow(suggestions.length, selected);
  const width = Math.max(...suggestions.map(s => s.label.length));
  return (
    <Box flexDirection="column">
      {suggestions.slice(start, end).map((s, i) => {
        const isSelected = start + i === selected;
        return (
          <Box key={s.label}>
            <Text color={isSelected ? theme.accent : undefined}>
              {isSelected ? "▶ " : "  "}{s.label.padEnd(width + 2)}
            </Text>
            {s.description && <Text color={theme.muted}>{s.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
