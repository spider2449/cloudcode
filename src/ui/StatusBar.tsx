import React from "react";
import { Text } from "ink";

interface Props { provider: string; model?: string; mode: string; cwd: string; costUsd?: number }

export function StatusBar({ provider, model, mode, cwd, costUsd }: Props) {
  return (
    <Text color="gray" dimColor>
      {provider}{model ? `/${model}` : ""} · {mode} · {cwd}{costUsd && costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : ""}
    </Text>
  );
}
