import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useTheme } from "./ThemeContext.js";
import { configDir } from "../agent/providers.js";
import { memoryDir } from "../engine/memoryPaths.js";

export interface MemoryOption {
  label: string;
  path: string;
  kind: "file" | "folder";
}

export function buildMemoryOptions(cwd: string, base: string = configDir()): MemoryOption[] {
  const userPath = join(base, "CLAUDE.md");
  const projectPath = join(cwd, "CLAUDE.md");
  const suffix = (p: string) => (existsSync(p) ? "" : " (new)");
  return [
    { label: `User memory${suffix(userPath)}`, path: userPath, kind: "file" },
    { label: `Project memory${suffix(projectPath)}`, path: projectPath, kind: "file" },
    { label: "Open auto-memory folder", path: memoryDir(cwd, base), kind: "folder" }
  ];
}

interface Props {
  options: MemoryOption[];
  onPick(option: MemoryOption): void;
  onCancel(): void;
}

export function MemoryPicker({ options, onPick, onCancel }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(options.length - 1, i + 1));
    else if (key.return && options[index]) onPick(options[index]);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.warning}>Memory (↑/↓, Enter, Esc)</Text>
      {options.map((o, i) => (
        <Text key={o.path} inverse={i === index}>{o.label}</Text>
      ))}
    </Box>
  );
}
