import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./ThemeContext.js";

interface Props {
  projects: string[];
  currentCwd: string;
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ projects, currentCwd, onPick, onCancel }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(projects.length - 1, i + 1));
    else if (key.return && projects[index]) {
      if (projects[index] === currentCwd) onCancel();
      else onPick(projects[index]);
    }
  });

  if (projects.length === 0) {
    return <Text color={theme.muted}>No recent projects. Press Esc to close.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.warning}>Switch project (↑/↓, Enter, Esc)</Text>
      {projects.map((p, i) => (
        <Text key={p} inverse={i === index}>
          {p === currentCwd ? "● " : "  "}{p}
        </Text>
      ))}
    </Box>
  );
}
