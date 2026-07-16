import type { EngineMessage, ContentBlock, Usage } from "./messages.js";
import { textDelta, thinkingDelta, assistantMessage, errorResult, toolResultMessage } from "./messages.js";
import type { ToolDef } from "./tools/types.js";
import type { MessagesClient } from "./api.js";
import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";
import { decidePermission } from "./permissions.js";
import { costUsd } from "./pricing.js";
import { compactHistory, estimateTokens } from "./compact.js";
import { EFFORT_BUDGETS, type EffortLevel } from "./effort.js";

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
  effort?: EffortLevel;
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
  private effort: EffortLevel;
  private systemPrompt: string;

  constructor(private opts: EngineOptions) {
    this.model = opts.model;
    this.mode = opts.permissionMode;
    this.tools = opts.tools;
    this.effort = opts.effort ?? "off";
    this.systemPrompt = opts.systemPrompt;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setEffort(level: EffortLevel): void {
    this.effort = level;
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
        if (turn.stopReason !== "tool_use") {
          // No tool calls this turn: emit the whole batch as one assistant
          // message, same as before.
          this.opts.onMessage(assistantMessage(turn.blocks));
          break;
        }
        // Tool calls present: emit each block's label/diff immediately
        // followed by its own result, so the transcript groups
        // tool-label -> diff -> result per tool instead of batching all
        // labels first and all results after (see Task 6 review finding).
        const results = [];
        for (const block of turn.blocks) {
          this.opts.onMessage(assistantMessage([block]));
          if (block.type !== "tool_use") continue;
          const result = await this.runTool(block);
          results.push(result);
          this.opts.onMessage(toolResultMessage(result.tool_use_id, result.content, result.is_error === true));
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

  async compact(client: MessagesClient, model: string, onProgress?: (pct: number) => void): Promise<number> {
    this.messages = await compactHistory(client, model, this.messages, onProgress);
    return estimateTokens(this.messages);
  }

  private async streamOnce(signal: AbortSignal): Promise<StreamedTurn> {
    const blocks: ContentBlock[] = [];
    let pendingJson = "";
    let stopReason: string | undefined;
    let usage: Usage | undefined;
    // Commits any JSON accumulated for the current tool_use block into its
    // `input`. Normally content_block_stop does this, but some non-Anthropic
    // providers drop or reorder that event; without this safety net, the next
    // content_block_start (or the end of the stream) would silently discard
    // the pending JSON and leave `input: {}` on the block permanently.
    const finalizePendingToolInput = () => {
      const last = blocks[blocks.length - 1];
      if (last?.type === "tool_use" && pendingJson.trim() !== "") {
        try {
          last.input = JSON.parse(pendingJson);
        } catch {
          last.input = {};
        }
      }
      pendingJson = "";
    };
    // With extended thinking enabled, budget_tokens counts against
    // max_tokens, so raise the cap to keep MAX_TOKENS available for the
    // visible answer.
    const budget = this.effort === "off" ? undefined : EFFORT_BUDGETS[this.effort];
    const req = {
      model: this.model,
      system: [{ type: "text" as const, text: this.systemPrompt, cache_control: { type: "ephemeral" as const } }],
      messages: withCacheControlOnLastBlock(this.messages),
      tools: this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: budget === undefined ? MAX_TOKENS : budget + MAX_TOKENS,
      ...(budget === undefined ? {} : { thinking: { type: "enabled" as const, budget_tokens: budget } })
    };
    for await (const event of this.opts.client.create(req, signal)) {
      const type = event.type as string;
      if (type === "content_block_start") {
        const cb = event.content_block as { type: string; text?: string; id?: string; name?: string; thinking?: string };
        finalizePendingToolInput();
        if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
        else if (cb.type === "thinking") blocks.push({ type: "thinking", thinking: cb.thinking ?? "", signature: "" });
        else if (cb.type === "tool_use") {
          blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
        const last = blocks[blocks.length - 1];
        if (delta.type === "text_delta" && last?.type === "text") {
          last.text += delta.text ?? "";
          this.opts.onMessage(textDelta(delta.text ?? ""));
        } else if (delta.type === "thinking_delta" && last?.type === "thinking") {
          last.thinking += delta.thinking ?? "";
          this.opts.onMessage(thinkingDelta(delta.thinking ?? ""));
        } else if (delta.type === "signature_delta" && last?.type === "thinking") {
          last.signature += delta.signature ?? "";
        } else if (delta.type === "input_json_delta" && last?.type === "tool_use") {
          pendingJson += delta.partial_json ?? "";
        }
      } else if (type === "content_block_stop") {
        finalizePendingToolInput();
      } else if (type === "message_start") {
        const msg = event.message as { usage?: Usage };
        if (msg.usage) usage = { ...usage, ...msg.usage };
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string };
        stopReason = delta.stop_reason ?? stopReason;
        if (event.usage) usage = { ...(usage as Usage), ...(event.usage as Partial<Usage>) } as Usage;
      }
    }
    finalizePendingToolInput();
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
