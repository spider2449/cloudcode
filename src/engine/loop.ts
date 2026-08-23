import type { EngineMessage, ContentBlock, Usage } from "./messages.js";
import { textDelta, thinkingDelta, assistantMessage, errorResult, limitMessage, toolResultMessage } from "./messages.js";
import type { FileMutationObserver, ToolDef } from "./tools/types.js";
import type { MessagesClient } from "./api.js";
import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";
import type { NetworkPolicy } from "../agent/networkPolicy.js";
import { decidePermission } from "./permissions.js";
import { costUsd } from "./pricing.js";
import { compactHistory } from "./compact.js";
import { EFFORT_HEADROOM, clampEffortHeadroom, allowsDisabledThinking, type EffortLevel } from "./effort.js";
import { DEFAULT_CONTEXT_WINDOW } from "../agent/providers.js";
import type { LspManager } from "./lsp/manager.js";
import { appendDiagnostics } from "./lsp/autoInject.js";
import { RunLimitError, validateRunLimits, type RunLimitKind, type RunLimits } from "./runLimits.js";

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
  lsp?: LspManager;
  fileMutations?: FileMutationObserver;
  networkPolicy?: NetworkPolicy;
  effort?: EffortLevel;
  contextWindow?: number;
  runLimits?: RunLimits;
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

export interface ContextSnapshot {
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  inputTokens?: number;
}

const estimate = (text: string) => Math.ceil(text.length / 4);

export class EngineLoop {
  messages: unknown[] = [];
  tools: ToolDef[];
  private model: string;
  private mode: PermissionMode;
  private effort: EffortLevel;
  private systemPrompt: string;
  private lastSnapshot: ContextSnapshot | undefined;

  constructor(private opts: EngineOptions) {
    this.model = opts.model;
    this.mode = opts.permissionMode;
    this.tools = opts.tools;
    this.effort = opts.effort ?? "off";
    this.systemPrompt = opts.systemPrompt;
    validateRunLimits(opts.runLimits, opts.model);
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
    let hitTurnLimit = true;
    let providerRequests = 0;
    let reached: RunLimitKind | undefined;
    const markLimit = (limit: RunLimitKind, value: number) => {
      if (reached) return;
      reached = limit;
      this.opts.onMessage(limitMessage(limit, value));
    };
    const addUsage = (next: Usage | undefined) => {
      if (!next) return;
      usage = {
        input_tokens: (usage?.input_tokens ?? 0) + (next.input_tokens ?? 0),
        output_tokens: (usage?.output_tokens ?? 0) + (next.output_tokens ?? 0),
        cache_read_input_tokens: (usage?.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
        cache_creation_input_tokens: (usage?.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0)
      };
    };
    try {
      for (let i = 0; i < MAX_LOOP_TURNS; i++) {
        if (this.opts.runLimits?.maxTurns !== undefined && providerRequests >= this.opts.runLimits.maxTurns) {
          markLimit("maxTurns", this.opts.runLimits.maxTurns);
          hitTurnLimit = false;
          break;
        }
        providerRequests++;
        const turn = await this.streamOnce(signal);
        addUsage(turn.usage);
        addCost(turn.usage);
        const costReached = this.opts.runLimits?.maxCostUsd !== undefined &&
          totalCost !== undefined && totalCost >= this.opts.runLimits.maxCostUsd;
        // An empty content array is not valid API input, so keep it out of the
        // history entirely rather than poisoning the next turn's request.
        if (turn.blocks.length > 0) this.messages.push({ role: "assistant", content: turn.blocks });
        if (turn.stopReason !== "tool_use") {
          hitTurnLimit = false;
          // No tool calls this turn: emit the whole batch as one assistant
          // message, same as before.
          this.opts.onMessage(assistantMessage(turn.blocks));
          if (turn.stopReason === "max_tokens") {
            // UI-only notice; never pushed into this.messages so the API
            // history stays exactly what the model produced.
            this.opts.onMessage(assistantMessage([
              { type: "text", text: "\n[Response truncated: hit the max_tokens output limit]" }
            ]));
          }
          if (costReached && this.opts.runLimits?.maxCostUsd !== undefined) {
            markLimit("maxCostUsd", this.opts.runLimits.maxCostUsd);
          }
          break;
        }
        if (signal.aborted) {
          hitTurnLimit = false;
          break;
        }
        if (costReached && this.opts.runLimits?.maxCostUsd !== undefined) {
          markLimit("maxCostUsd", this.opts.runLimits.maxCostUsd);
          hitTurnLimit = false;
          break;
        }
        if (this.opts.runLimits?.maxTurns !== undefined && providerRequests >= this.opts.runLimits.maxTurns) {
          markLimit("maxTurns", this.opts.runLimits.maxTurns);
          hitTurnLimit = false;
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
          // After an interrupt, still emit a tool_result for every remaining
          // tool_use id (the API requires one per id on resume), but do not
          // execute the tools.
          const result = signal.aborted
            ? { type: "tool_result", tool_use_id: block.id, content: "Interrupted by user", is_error: true }
            : await this.runTool(block, signal);
          results.push(result);
          this.opts.onMessage(toolResultMessage(result.tool_use_id, result.content, result.is_error === true));
        }
        // stop_reason said "tool_use" but the turn carried no tool_use block
        // (seen with OpenAI-compatible providers). Pushing an empty content
        // array would be rejected by the API on the next request and the loop
        // would spin until MAX_LOOP_TURNS, so stop here instead.
        if (results.length === 0) {
          hitTurnLimit = false;
          this.opts.onMessage(assistantMessage([
            { type: "text", text: "\n[Provider reported a tool call but sent no tool input; stopping this turn]" }
          ]));
          break;
        }
        this.messages.push({ role: "user", content: results });
        if (signal.aborted) {
          hitTurnLimit = false;
          break;
        }
      }
      if (hitTurnLimit) {
        // UI-only notice, like the max_tokens one above: the history stays
        // exactly what the model produced, but the user is told why the turn
        // ended without a final answer.
        this.opts.onMessage(assistantMessage([
          { type: "text", text: `\n[Stopped after ${MAX_LOOP_TURNS} tool-use turns without a final answer]` }
        ]));
        markLimit("maxTurns", MAX_LOOP_TURNS);
      }
      const abortLimit = signal.reason instanceof RunLimitError ? signal.reason : undefined;
      if (abortLimit) markLimit(abortLimit.limit, abortLimit.value);
      this.opts.onMessage({
        type: "result",
        subtype: "success",
        duration_ms: Date.now() - started,
        usage,
        total_cost_usd: costKnown ? totalCost : undefined,
        finish_reason: reached ? "limit" : signal.aborted ? "interrupted" : "completed"
      });
    } catch (err) {
      if (signal.aborted) {
        const abortLimit = signal.reason instanceof RunLimitError ? signal.reason : undefined;
        if (abortLimit) markLimit(abortLimit.limit, abortLimit.value);
        this.opts.onMessage({
          type: "result",
          subtype: "success",
          duration_ms: Date.now() - started,
          usage,
          total_cost_usd: costKnown ? totalCost : undefined,
          finish_reason: reached ? "limit" : "interrupted"
        });
      } else {
        this.opts.onMessage(errorResult(err instanceof Error ? err.message : String(err)));
      }
    }
  }

  async compact(client: MessagesClient, model: string, onProgress?: (pct: number) => void): Promise<number> {
    this.messages = await compactHistory(client, model, this.messages, onProgress);
    // The cached snapshot describes the request that was actually sent to the
    // API, which is now stale — the shrunk history has no real usage numbers
    // yet. Drop it so contextSnapshot() re-estimates from the compacted state
    // instead of reporting the pre-compact turn forever.
    this.lastSnapshot = undefined;
    const snap = this.contextSnapshot();
    return snap.systemTokens + snap.toolsTokens + snap.messagesTokens;
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
    // "off" must send thinking explicitly disabled: current models treat an
    // omitted thinking param as adaptive-on, so omitting it would silently
    // ignore the user's setting. On models that refuse to switch thinking off
    // at all, "off" degrades to the lowest effort level — the closest thing to
    // "spend as little as possible on reasoning" those models offer.
    const effectiveEffort: Exclude<EffortLevel, "off"> | undefined =
      this.effort !== "off" ? this.effort
        : allowsDisabledThinking(this.model) ? undefined
          : "low";
    // Adaptive thinking shares max_tokens with the visible answer, so raise
    // the cap by the level's headroom to keep MAX_TOKENS available for the
    // answer itself.
    const headroom = effectiveEffort === undefined
      ? 0
      : clampEffortHeadroom(EFFORT_HEADROOM[effectiveEffort], this.opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW, MAX_TOKENS);
    const req = {
      model: this.model,
      system: [{ type: "text" as const, text: this.systemPrompt, cache_control: { type: "ephemeral" as const } }],
      messages: withCacheControlOnLastBlock(this.messages),
      tools: this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: MAX_TOKENS + headroom,
      ...(effectiveEffort === undefined
        ? { thinking: { type: "disabled" as const } }
        : { thinking: { type: "adaptive" as const }, output_config: { effort: effectiveEffort } })
    };
    this.lastSnapshot = {
      systemTokens: estimate(this.systemPrompt),
      toolsTokens: estimate(JSON.stringify(req.tools)),
      messagesTokens: estimate(JSON.stringify(req.messages)),
      inputTokens: this.lastSnapshot?.inputTokens
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
    if (usage && this.lastSnapshot) {
      this.lastSnapshot.inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    }
    return { blocks, stopReason, usage };
  }

  contextSnapshot(): ContextSnapshot {
    if (this.lastSnapshot) return this.lastSnapshot;
    return {
      systemTokens: estimate(this.systemPrompt),
      toolsTokens: estimate(JSON.stringify(this.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })))),
      messagesTokens: estimate(JSON.stringify(this.messages))
    };
  }

  private async runTool(block: { id: string; name: string; input: Record<string, unknown> }, signal: AbortSignal) {
    const deniedResult = (msg: string) => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: msg,
      is_error: true
    });
    const tool = this.tools.find(t => t.name === block.name);
    if (!tool) return deniedResult(`Unknown tool: ${block.name}`);
    let decision = decidePermission(block.name, block.input, this.mode, this.opts.store, this.opts.cwd);
    if (decision === "ask") {
      decision = (await this.opts.requestPermission(block.name, block.input)) ? "allow" : "deny";
    }
    if (decision === "deny") return deniedResult("User denied this tool use");
    try {
      const out = await tool.execute(block.input, {
        cwd: this.opts.cwd,
        signal,
        lsp: this.opts.lsp,
        fileMutations: this.opts.fileMutations,
        networkPolicy: this.opts.networkPolicy
      });
      const content = await appendDiagnostics(block.name, block.input, out.content, this.opts.lsp, this.opts.cwd);
      return { type: "tool_result", tool_use_id: block.id, content, is_error: out.isError === true };
    } catch (err) {
      return deniedResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
