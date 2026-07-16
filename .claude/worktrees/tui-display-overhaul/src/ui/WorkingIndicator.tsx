import React, { useEffect, useState } from "react";
import { Text } from "ink";
import Spinner from "ink-spinner";
import { useTheme } from "./ThemeContext.js";

interface Props {
  label: string;
  startedAt: number;
}

export function WorkingIndicator({ label, startedAt }: Props) {
  const theme = useTheme();
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text color={theme.accent}>
      <Spinner type="dots" /> {label}… <Text color={theme.muted}>({seconds}s · Esc to interrupt)</Text>
    </Text>
  );
}
