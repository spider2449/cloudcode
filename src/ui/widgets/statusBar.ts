import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import { stringWidth, truncateToWidth } from "../width.js";
import { DEFAULT_STATUS_LINE_ITEMS, STATUS_LINE_ITEMS } from "../../statusLineItems.js";
import type { StatusLineItem } from "../../statusLineItems.js";

export interface StatusBarProps {
  provider: string;
  model?: string;
  servedModel?: string;
  effort?: string;
  mode: string;
  networkMode?: string;
  cwd: string;
  costUsd?: number;
  gitBranch?: string;
  gitDirty?: boolean;
  tokens?: number;
  contextPct?: number;
  elapsedMs?: number;
  /** Which segments to render, in order; omitted means the curated default. */
  items?: StatusLineItem[];
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

function segmentFor(item: StatusLineItem, p: StatusBarProps, servedEnabled: boolean): string | null {
  switch (item) {
    case "model": {
      const base = servedEnabled ? p.servedModel ?? p.model : p.model;
      const label =
        servedEnabled && p.servedModel && p.model && p.servedModel !== p.model
          ? `${p.model}→${p.servedModel}`
          : base;
      return label ? `${p.provider}/${label}` : p.provider;
    }
    case "servedModel":
      return null; // folded into the model segment via the arrow
    case "effort":
      return p.effort != null ? `effort: ${p.effort}` : null;
    case "mode":
      return p.mode;
    case "network":
      return p.networkMode ? `network: ${p.networkMode}` : null;
    case "branch":
      return p.gitBranch ? `⎇ ${p.gitBranch}${p.gitDirty ? "*" : ""}` : null;
    case "tokens":
      return p.tokens != null && p.tokens > 0
        ? formatTokens(p.tokens) + (p.contextPct != null ? ` (${p.contextPct}%)` : "")
        : null;
    case "cost":
      return p.costUsd != null && p.costUsd > 0 ? `$${p.costUsd.toFixed(4)}` : null;
    case "elapsed":
      return p.elapsedMs != null && p.elapsedMs > 0 ? formatElapsed(p.elapsedMs) : null;
    case "cwd":
      return p.cwd;
  }
}

export function renderStatusBar(p: StatusBarProps, theme: Theme, width: number): string[] {
  const requested = p.items ?? DEFAULT_STATUS_LINE_ITEMS;
  const servedEnabled = requested.includes("servedModel");
  const segments: string[] = [];
  // Walk the registry (not the user list) so segment order is deterministic
  // even if a caller passes an unordered or duplicated list.
  for (const item of STATUS_LINE_ITEMS) {
    if (!requested.includes(item)) continue;
    const segment = segmentFor(item, p, servedEnabled);
    if (segment != null) segments.push(segment);
  }
  // Pack whole segments onto rows of at most `width` columns instead of
  // truncating: overflowing segments wrap onto extra rows. No emitted row may
  // ever exceed the terminal width (legacy conhost ignores DECAWM-off), so a
  // single segment wider than the whole terminal is ellipsis-truncated.
  const SEP = " · ";
  const rows: string[] = [];
  let current = "";
  for (let segment of segments) {
    if (stringWidth(segment) > width) segment = truncateToWidth(segment, width);
    if (current === "") current = segment;
    else if (stringWidth(current) + SEP.length + stringWidth(segment) <= width) current += SEP + segment;
    else { rows.push(current); current = segment; }
  }
  if (current !== "") rows.push(current);
  const code = sgr(theme.muted);
  return code ? rows.map(r => `${code}${r}${SGR_RESET}`) : rows;
}
