import type { EngineMessage } from "../engine/messages.js";
import { stringWidth, truncateToWidth } from "./width.js";

export type DiffLine = { sign: "+" | "-" | " "; text: string };

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "notice"; text: string }
  | { kind: "welcome"; logo: string; body: string }
  | { kind: "error"; text: string }
  | { kind: "result"; costUsd?: number; durationMs?: number }
  | { kind: "diff"; lines: DiffLine[] }
  | { kind: "toolResult"; text: string; extra: number; isError: boolean };

export function truncate(s: string, max = 80): string {
  return stringWidth(s) > max ? truncateToWidth(s, max) : s;
}

export function streamDelta(msg: EngineMessage): string | undefined {
  const m = msg as Record<string, unknown>;
  if (m.type !== "stream_event") return undefined;
  const event = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text;
  }
  return undefined;
}

export function streamThinkingDelta(msg: EngineMessage): string | undefined {
  const m = msg as Record<string, unknown>;
  if (m.type !== "stream_event") return undefined;
  const event = m.event as { type?: string; delta?: { type?: string; thinking?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
    return event.delta.thinking;
  }
  return undefined;
}

// Classic LCS table walk producing a unified-style line diff.
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { out.push({ sign: " ", text: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ sign: "-", text: oldLines[i++] });
    else out.push({ sign: "+", text: newLines[j++] });
  }
  while (i < m) out.push({ sign: "-", text: oldLines[i++] });
  while (j < n) out.push({ sign: "+", text: newLines[j++] });
  return out;
}

// Collapse unchanged runs longer than 2*ctx+1 to ctx lines on each side with
// a "…" marker between; leading/trailing runs keep only ctx lines.
function collapseContext(lines: DiffLine[], ctx = 2): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (leading: boolean, trailing: boolean) => {
    if (run.length === 0) return;
    const limit = ctx;
    if (leading) {
      if (run.length > limit) out.push({ sign: " ", text: "…" }, ...run.slice(run.length - limit));
      else out.push(...run);
    } else if (trailing) {
      out.push(...run.slice(0, limit));
      if (run.length > limit) out.push({ sign: " ", text: "…" });
    } else if (run.length > 2 * limit + 1) {
      out.push(...run.slice(0, limit), { sign: " ", text: "…" }, ...run.slice(run.length - limit));
    } else {
      out.push(...run);
    }
    run = [];
  };
  let seenChange = false;
  for (const l of lines) {
    if (l.sign === " ") { run.push(l); continue; }
    flush(!seenChange, false);
    seenChange = true;
    out.push(l);
  }
  flush(false, true);
  return out;
}

export function diffLines(name: string, input: Record<string, unknown>, cap = 20): DiffLine[] {
  const lines: DiffLine[] = [];
  if (name === "Edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (oldStr !== "" && newStr !== "") {
      lines.push(...collapseContext(lcsDiff(oldStr.split("\n"), newStr.split("\n"))));
    } else {
      // Fallback: pure insertion or deletion keeps the simple dump format.
      if (oldStr !== "") for (const l of oldStr.split("\n")) lines.push({ sign: "-", text: l });
      if (newStr !== "") for (const l of newStr.split("\n")) lines.push({ sign: "+", text: l });
    }
  } else if (name === "Write") {
    if (typeof input.content === "string" && input.content !== "") {
      for (const l of input.content.split("\n")) lines.push({ sign: "+", text: l });
    }
  }
  if (lines.length > cap) {
    const extra = lines.length - cap;
    return [...lines.slice(0, cap), { sign: " ", text: `… (+${extra} more)` }];
  }
  return lines;
}

export function toolLabel(name: string, input: Record<string, unknown>): string {
  let detail: string;
  // Every branch is truncated: an untruncated file_path (e.g. a long
  // generated path) would let PermissionDialog's single Text line wrap to
  // an unbounded number of rows, breaking App.tsx's fixed overlayRows cap.
  if (typeof input.file_path === "string") detail = truncate(input.file_path);
  else if (typeof input.command === "string") detail = truncate(input.command);
  else detail = truncate(JSON.stringify(input));
  return `${name} ${detail}`;
}

function toolResultPreview(content: unknown): { text: string; extra: number } {
  const s =
    typeof content === "string" ? content
    : Array.isArray(content)
      ? content.map(b => (typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n")
    : content == null ? ""
    : JSON.stringify(content);
  const lines = s.split("\n").filter(l => l.trim() !== "");
  if (lines.length === 0) return { text: "(no output)", extra: 0 };
  return { text: lines[0].trim(), extra: lines.length - 1 };
}

export function toDisplayItems(msg: EngineMessage): DisplayItem[] {
  const m = msg as Record<string, unknown>;
  if (m.type === "assistant") {
    const content = (m.message as { content: Array<Record<string, unknown>> }).content ?? [];
    const items: DisplayItem[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push({ kind: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        items.push({
          kind: "tool",
          label: toolLabel(String(block.name), (block.input ?? {}) as Record<string, unknown>)
        });
        const dl = diffLines(String(block.name), (block.input ?? {}) as Record<string, unknown>);
        if (dl.length > 0) items.push({ kind: "diff", lines: dl });
      }
    }
    return items;
  }
  if (m.type === "tool_result") {
    const preview = toolResultPreview(m.content);
    return [{ kind: "toolResult", text: preview.text, extra: preview.extra, isError: m.is_error === true }];
  }
  if (m.type === "result") {
    if (m.subtype === "success") {
      return [{ kind: "result", costUsd: m.total_cost_usd as number, durationMs: m.duration_ms as number }];
    }
    return [{ kind: "error", text: String(m.result ?? m.subtype) }];
  }
  return [];
}
