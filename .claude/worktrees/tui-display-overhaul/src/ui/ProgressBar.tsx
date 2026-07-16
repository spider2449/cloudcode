import React from "react";
import { Text } from "ink";
import { useTheme } from "./ThemeContext.js";

interface Props {
  label: string;
  pct: number;
  width?: number;
}

export function ProgressBar({ label, pct, width = 20 }: Props) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return (
    <Text color={theme.accent}>
      {label} <Text color={theme.muted}>[{bar}] {clamped}%</Text>
    </Text>
  );
}
