import type { EngineMessage } from "../engine/messages.js";

export type DiffLine = { sign: "+" | "-" | " "; text: string };

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  | { kind: "result"; costUsd?: number; durationMs?: number }
  | { kind: "diff"; lines: DiffLine[] };

export function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
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

export function diffLines(name: string, input: Record<string, unknown>, cap = 20): DiffLine[] {
  const lines: DiffLine[] = [];
  if (name === "Edit") {
    if (typeof input.old_string === "string" && input.old_string !== "") {
      for (const l of input.old_string.split("\n")) lines.push({ sign: "-", text: l });
    }
    if (typeof input.new_string === "string" && input.new_string !== "") {
      for (const l of input.new_string.split("\n")) lines.push({ sign: "+", text: l });
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
  if (m.type === "result") {
    if (m.subtype === "success") {
      return [{ kind: "result", costUsd: m.total_cost_usd as number, durationMs: m.duration_ms as number }];
    }
    return [{ kind: "error", text: String(m.result ?? m.subtype) }];
  }
  return [];
}
