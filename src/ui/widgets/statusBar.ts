import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export interface StatusBarProps {
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

export function renderStatusBar(p: StatusBarProps, theme: Theme, width: number): string {
  const segments: string[] = [];
  const modelLabel =
    p.servedModel && p.model && p.servedModel !== p.model ? `${p.model}→${p.servedModel}` : p.servedModel ?? p.model;
  segments.push(p.provider + (modelLabel ? `/${modelLabel}` : ""));
  segments.push(p.mode);
  if (p.gitBranch) segments.push(`⎇ ${p.gitBranch}${p.gitDirty ? "*" : ""}`);
  if (p.tokens != null && p.tokens > 0) {
    segments.push(formatTokens(p.tokens) + (p.contextPct != null ? ` (${p.contextPct}%)` : ""));
  }
  if (p.costUsd && p.costUsd > 0) segments.push(`$${p.costUsd.toFixed(4)}`);
  if (p.elapsedMs != null && p.elapsedMs > 0) segments.push(formatElapsed(p.elapsedMs));
  segments.push(p.cwd);
  // Truncate to the terminal width: an overlong bottom row wraps, which
  // scrolls the whole alt screen up and clips the top of the transcript.
  let text = segments.join(" · ");
  if (text.length > width) text = text.slice(0, Math.max(0, width - 1)) + "…";
  const code = sgr(theme.muted);
  return code ? `${code}${text}${SGR_RESET}` : text;
}
