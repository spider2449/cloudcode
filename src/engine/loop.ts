import type { EngineMessage, ContentBlock, Usage } from "./messages.js";
import { textDelta, assistantMessage, errorResult } from "./messages.js";
import type { ToolDef } from "./tools/types.js";
import type { MessagesClient } from "./api.js";
import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";
import { decidePermission } from "./permissions.js";
import { costUsd } from "./pricing.js";
import { compactHistory } from "./compact.js";

const MAX_TOKENS = 8192;
const MAX_LOOP_TURNS = 100;

export interface EngineOptions {
  client: MessagesClient;
  model: string;
  systemPrompt: string;
  tools: ToolDef[];
  cwd: string;
  permissionMode: PermissionMode;
  store: PermissionStore;
  onMessage(msg: EngineMessage): void;
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

// Returns a copy of `messages` where the last content block of the final
// message carries an ephemeral cache_control marker, without mutating the
// original array/objects (so the marker never accumulates across turns).
function withCacheControlOnLastBlock(messages: unknown[]): unknown[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex] as { role: string; content: unknown };
  const blocks: unknown[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...(last.content as unknown[])];
  if (blocks.length === 0) return messages;
  const lastBlockIndex = blocks.length - 1;
  const lastBlock = blocks[lastBlockIndex] as Record<string, unknown>;
  blocks[lastBlockIndex] = { ...lastBlock, cache_control: { type: "ephemeral" } };
  const copy = messages.slice(0, lastIndex);
  copy.push({ ...last, content: blocks });
  return copy;
}

interface StreamedTurn {
  blocks: ContentBlock[];
  stopReason: string | undefined;
  usage: Usage | undefined;
}

export class EngineLoop {
  messages: unknown[] = [];
  tools: ToolDef[];
  private model: string;
  private mode: PermissionMode;

  constructor(private opts: EngineOptions) {
    this.model = opts.model;
    this.mode = opts.permissionMode;
    this.tools = opts.tools;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  async runTurn(userText: string, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    this.messages.push({ role: "user", content: userText });
    let usage: Usage | undefined;
    let totalCost: number | undefined;
    let costKnown = false;
    const addCost = (u: Usage | undefined) => {
      if (!u) return;
      const c = costUsd(this.model, u);
      if (c === undefined) return;
      costKnown = true;
      totalCost = (totalCost ?? 0) + c;
    };
    try {
      for (let i = 0; i < MAX_LOOP_TURNS; i++) {
        const turn = await this.streamOnce(signal);
        usage = turn.usage ?? usage;
        addCost(turn.usage);
        this.messages.push({ role: "assistant", content: turn.blocks });
        this.opts.onMessage(assistantMessage(turn.blocks));
        if (turn.stopReason !== "tool_use") break;
        const results = [];
        for (const block of turn.blocks) {
          if (block.type !== "tool_use") continue;
          results.push(await this.runTool(block));
        }
        this.messages.push({ role: "user", content: results });
      }
      this.opts.onMessage({
        type: "result",
        subtype: "success",
        duration_ms: Date.now() - started,
        usage,
        total_cost_usd: costKnown ? totalCost : undefined
      });
    } catch (err) {
      if (signal.aborted) {
        this.opts.onMessage({
          type: "result",
          subtype: "success",
          duration_ms: Date.now() - started,
          usage,
          total_cost_usd: costKnown ? totalCost : undefined
        });
      } else {
        this.opts.onMessage(errorResult(err instanceof Error ? err.message : String(err)));
      }
    }
  }

  async compact(client: MessagesClient, model: string): Promise<void> {
    this.messages = await compactHistory(client, model, this.messages);
  }

  private async streamOnce(signal: AbortSignal): Promise<StreamedTurn> {
    const blocks: ContentBlock[] = [];
    let pendingJson = "";
    let stopReason: string | undefined;
    let usage: Usage | undefined;
    const req = {
      model: this.model,
      system: [{ type: "text" as const, text: this.opts.systemPrompt, cache_control: { type: "ephemeral" as const } }],
      messages: withCacheControlOnLastBlock(this.messages),
      tools: this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: MAX_TOKENS
    };
    for await (const event of this.opts.client.create(req, signal)) {
      const type = event.type as string;
      if (type === "content_block_start") {
        const cb = event.content_block as { type: string; text?: string; id?: string; name?: string };
        if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
        else if (cb.type === "tool_use") {
          blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
          pendingJson = "";
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        const last = blocks[blocks.length - 1];
        if (delta.type === "text_delta" && last?.type === "text") {
          last.text += delta.text ?? "";
          this.opts.onMessage(textDelta(delta.text ?? ""));
        } else if (delta.type === "input_json_delta" && last?.type === "tool_use") {
          pendingJson += delta.partial_json ?? "";
        }
      } else if (type === "content_block_stop") {
        const last = blocks[blocks.length - 1];
        if (last?.type === "tool_use" && pendingJson.trim() !== "") {
          try {
            last.input = JSON.parse(pendingJson);
          } catch {
            last.input = {};
          }
          pendingJson = "";
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string };
        stopReason = delta.stop_reason ?? stopReason;
        if (event.usage) usage = event.usage as Usage;
      }
    }
    return { blocks, stopReason, usage };
  }

  private async runTool(block: { id: string; name: string; input: Record<string, unknown> }) {
    const deniedResult = (msg: string) => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: msg,
      is_error: true
    });
    const tool = this.tools.find(t => t.name === block.name);
    if (!tool) return deniedResult(`Unknown tool: ${block.name}`);
    let decision = decidePermission(block.name, block.input, this.mode, this.opts.store);
    if (decision === "ask") {
      decision = (await this.opts.requestPermission(block.name, block.input)) ? "allow" : "deny";
    }
    if (decision === "deny") return deniedResult("User denied this tool use");
    try {
      const out = await tool.execute(block.input, { cwd: this.opts.cwd });
      return { type: "tool_result", tool_use_id: block.id, content: out.content, is_error: out.isError === true };
    } catch (err) {
      return deniedResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
