import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessagesClient } from "./api.js";
import type { ContentBlock } from "./messages.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { isInsideMemoryDir } from "./memoryPaths.js";
import { MEMORY_TYPES, MAX_ENTRYPOINT_LINES } from "./memoryPrompt.js";

export const MIN_NEW_MESSAGES = 4;
export const MAX_EXTRACT_TURNS = 4;
const MAX_TOKENS = 2048;

export function countModelMessages(messages: unknown[], fromIndex: number): number {
  return messages.slice(fromIndex).length;
}

// True when any assistant tool_use after the cursor wrote inside the memory
// dir — the main agent already saved memories, so extraction is redundant.
export function hasMemoryWrites(messages: unknown[], fromIndex: number, dir: string): boolean {
  for (const msg of messages.slice(fromIndex) as Array<{ role?: string; content?: unknown }>) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; input?: { file_path?: unknown } }>) {
      if (block.type !== "tool_use") continue;
      if (block.name !== "Write" && block.name !== "Edit") continue;
      const p = block.input?.file_path;
      if (typeof p === "string" && isInsideMemoryDir(p, dir)) return true;
    }
  }
  return false;
}

// Flatten recent conversation into plain text for the extraction prompt.
// Tool results are dropped (too large, rarely memory-relevant); tool calls
// are kept as one-line markers so the extractor sees what work happened.
export function formatTranscript(messages: unknown[], fromIndex: number): string {
  const out: string[] = [];
  for (const msg of messages.slice(fromIndex) as Array<{ role?: string; content?: unknown }>) {
    if (typeof msg.content === "string") {
      out.push(`${(msg.role ?? "user").toUpperCase()}: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; text?: string; name?: string }>) {
      if (block.type === "text" && block.text) out.push(`${(msg.role ?? "").toUpperCase()}: ${block.text}`);
      else if (block.type === "tool_use") out.push(`[tool: ${block.name}]`);
      // tool_result and thinking blocks are intentionally skipped
    }
  }
  return out.join("\n");
}

// One-line-per-file manifest of existing memories (frontmatter description).
function memoryManifest(dir: string): string {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".md") && f !== "MEMORY.md")
      .slice(0, 200)
      .map(f => {
        const head = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 10).join("\n");
        const desc = /description:\s*(.+)/.exec(head)?.[1] ?? "";
        return `- ${f}: ${desc}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

function extractionPrompt(dir: string, transcript: string, manifest: string): string {
  const existing = manifest
    ? `\n\n## Existing memory files\n${manifest}\nCheck this list before writing — update an existing file rather than creating a duplicate.`
    : "";
  return `You are a memory extraction agent. Analyze the conversation transcript below and save durable memories to \`${dir}\` using the Write/Edit tools (Read first when editing). Do not investigate anything beyond the transcript.

Memory types: ${MEMORY_TYPES.join(", ")}. Save only context NOT derivable from the repo (no code patterns, git history, fix recipes, or CLAUDE.md content; no ephemeral task state). If nothing is worth saving, reply with just "nothing to save".

Each memory is its own .md file with frontmatter (name, description, type). After writing a file, add one index line to \`${join(dir, "MEMORY.md")}\`: \`- [Title](file.md) — one-line hook\` (index only, max ${MAX_ENTRYPOINT_LINES} lines, never content).${existing}

## Transcript
${transcript}`;
}

interface ExtractionOptions {
  client: MessagesClient;
  model: string;
  memoryDir: string;
  messages: unknown[];
  fromIndex: number;
}

// Collect one non-streamed response from the events the client yields.
async function collectResponse(
  client: MessagesClient, req: Record<string, unknown>, signal: AbortSignal
): Promise<{ blocks: ContentBlock[]; stopReason: string | undefined }> {
  const blocks: ContentBlock[] = [];
  let pendingJson = "";
  let stopReason: string | undefined;
  const finalize = () => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "tool_use" && pendingJson.trim() !== "") {
      try { last.input = JSON.parse(pendingJson); } catch { last.input = {}; }
    }
    pendingJson = "";
  };
  for await (const event of client.create(req as never, signal)) {
    const e = event as { type?: string; content_block?: { type: string; text?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
    if (e.type === "content_block_start" && e.content_block) {
      finalize();
      const cb = e.content_block;
      if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
      else if (cb.type === "tool_use") blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
    } else if (e.type === "content_block_delta" && e.delta) {
      const last = blocks[blocks.length - 1];
      if (e.delta.type === "text_delta" && last?.type === "text") last.text += e.delta.text ?? "";
      else if (e.delta.type === "input_json_delta" && last?.type === "tool_use") pendingJson += e.delta.partial_json ?? "";
    } else if (e.type === "content_block_stop") {
      finalize();
    } else if (e.type === "message_delta" && e.delta) {
      stopReason = e.delta.stop_reason ?? stopReason;
    }
  }
  finalize();
  return { blocks, stopReason };
}

// Run the extraction mini-loop. Tools are restricted: Read anywhere,
// Write/Edit only inside the memory directory. Returns true if a file
// inside the memory dir was written or edited.
export async function runExtraction(opts: ExtractionOptions): Promise<boolean> {
  const { client, model, memoryDir: dir } = opts;
  const transcript = formatTranscript(opts.messages, opts.fromIndex);
  if (transcript.trim() === "") return false;
  const tools = [readTool, writeTool, editTool];
  const messages: unknown[] = [{ role: "user", content: extractionPrompt(dir, transcript, memoryManifest(dir)) }];
  const signal = new AbortController().signal;
  let wrote = false;
  for (let turn = 0; turn < MAX_EXTRACT_TURNS; turn++) {
    const { blocks, stopReason } = await collectResponse(client, {
      model,
      system: "You extract durable memories from agent conversations.",
      messages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: MAX_TOKENS
    }, signal);
    messages.push({ role: "assistant", content: blocks });
    if (stopReason !== "tool_use") break;
    const results = [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const tool = tools.find(t => t.name === block.name);
      const path = String((block.input as { file_path?: unknown }).file_path ?? "");
      const guarded = (block.name === "Write" || block.name === "Edit") && !isInsideMemoryDir(path, dir);
      if (!tool || guarded) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Denied: writes are only allowed inside the memory directory.", is_error: true });
        continue;
      }
      const out = await tool.execute(block.input, { cwd: dir });
      if ((block.name === "Write" || block.name === "Edit") && out.isError !== true) wrote = true;
      results.push({ type: "tool_result", tool_use_id: block.id, content: out.content, is_error: out.isError === true });
    }
    messages.push({ role: "user", content: results });
  }
  return wrote;
}
