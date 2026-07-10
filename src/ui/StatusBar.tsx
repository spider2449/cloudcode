import React from "react";
import { Text } from "ink";

interface Props { provider: string; model?: string; mode: string; cwd: string }

export function StatusBar({ provider, model, mode, cwd }: Props) {
  return (
    <Text color="gray" dimColor>
      {provider}{model ? `/${model}` : ""} · {mode} · {cwd}
    </Text>
  );
}
