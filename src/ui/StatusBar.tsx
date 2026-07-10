import React from "react";
import { Text } from "ink";
import { useTheme } from "./ThemeContext.js";

interface Props {
  provider: string;
  model?: string;
  servedModel?: string;
  mode: string;
  cwd: string;
  costUsd?: number;
  gitBranch?: string;
  gitDirty?: boolean;
  tokens?: number;
  contextPct?: number;
  elapsedMs?: number;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatusBar({ provider, model, servedModel, mode, cwd, costUsd, gitBranch, gitDirty, tokens, contextPct, elapsedMs }: Props) {
  const theme = useTheme();
  const segments: string[] = [];
  const modelLabel =
    servedModel && model && servedModel !== model ? `${model}→${servedModel}` : servedModel ?? model;
  segments.push(provider + (modelLabel ? `/${modelLabel}` : ""));
  segments.push(mode);
  if (gitBranch) segments.push(`⎇ ${gitBranch}${gitDirty ? "*" : ""}`);
  if (tokens != null && tokens > 0) {
    segments.push(formatTokens(tokens) + (contextPct != null ? ` (${contextPct}%)` : ""));
  }
  if (costUsd && costUsd > 0) segments.push(`$${costUsd.toFixed(4)}`);
  if (elapsedMs != null && elapsedMs > 0) segments.push(formatElapsed(elapsedMs));
  segments.push(cwd);
  return (
    <Text color={theme.muted} dimColor>
      {segments.join(" · ")}
    </Text>
  );
}
