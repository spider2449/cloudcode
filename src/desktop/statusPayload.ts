import { STATUS_LINE_ITEMS } from "../statusLineItems.js";
import type { StatusLineItem } from "../statusLineItems.js";

// Raw status snapshot the gui-server backend sends to the desktop shell.
// The renderer formats it via formatStatusSegments (same segment semantics as
// src/ui/widgets/statusBar.ts, minus ANSI colors and terminal width packing).
export interface DesktopStatusPayload {
  provider: string;
  model?: string;
  servedModel?: string;
  effort?: string;
  mode: string;
  networkMode?: string;
  cwd: string;
  costUsd: number;
  tokens?: number;
  contextPct?: number;
  elapsedMs?: number;
  statusLineItems: StatusLineItem[];
  // Renderer-only overlay: the gui-server backend never sets this (it has no
  // git view); the shell fills it from its gitState poll before formatting.
  branchInfo?: { name: string; dirty: boolean };
}

export function formatDesktopTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export function formatDesktopElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function segmentFor(
  item: StatusLineItem,
  p: DesktopStatusPayload,
  servedEnabled: boolean
): string | null {
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
      // Git branch is overlaid by the renderer (it already polls gitState);
      // the backend leaves a null placeholder so ordering stays canonical
      // unless branchInfo is supplied (renderer path).
      return p.branchInfo ? `⎇ ${p.branchInfo.name}${p.branchInfo.dirty ? "*" : ""}` : null;
    case "tokens":
      return p.tokens != null && p.tokens > 0
        ? formatDesktopTokens(p.tokens) + (p.contextPct != null ? ` (${p.contextPct}%)` : "")
        : null;
    case "cost":
      return p.costUsd != null && p.costUsd > 0 ? `$${p.costUsd.toFixed(4)}` : null;
    case "elapsed":
      return p.elapsedMs != null && p.elapsedMs > 0 ? formatDesktopElapsed(p.elapsedMs) : null;
    case "cwd":
      return p.cwd;
  }
}

// Canonical-order segments for the enabled item list. The renderer appends
// the live git branch itself (see desktop/renderer/statusBar.tsx).
export function formatStatusSegments(p: DesktopStatusPayload): string[] {
  const requested = p.statusLineItems;
  const servedEnabled = requested.includes("servedModel");
  const segments: string[] = [];
  for (const item of STATUS_LINE_ITEMS) {
    if (!requested.includes(item)) continue;
    const segment = segmentFor(item, p, servedEnabled);
    if (segment != null) segments.push(segment);
  }
  return segments;
}
