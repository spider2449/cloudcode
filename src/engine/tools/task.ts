import { EngineLoop } from "../loop.js";
import { buildSubagentSystemPrompt } from "../systemPrompt.js";
import type { EffortLevel } from "../effort.js";
import type { LspManager } from "../lsp/manager.js";
import type { EngineMessage } from "../messages.js";
import type { MessagesClient } from "../api.js";
import type { NetworkPolicy } from "../../agent/networkPolicy.js";
import type { PermissionStore } from "../../agent/permissionStore.js";
import type { PermissionMode } from "../../agent/session.js";
import type { ToolDef, ToolOutput } from "./types.js";
import { readTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool } from "./lsp.js";

/** Subagents explore; they get far fewer turns than the main loop's 100. */
export const SUBAGENT_MAX_TURNS = 30;

export interface TaskToolDeps {
  client(): MessagesClient;
  model(): string;
  effort(): EffortLevel;
  contextWindow?(): number | undefined;
  permissionMode(): PermissionMode;
  store: PermissionStore;
  lsp?: LspManager;
  networkPolicy?: NetworkPolicy;
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

type SubagentDeps = Pick<
  TaskToolDeps,
  "client" | "model" | "effort" | "contextWindow" | "permissionMode" | "store" | "lsp" | "networkPolicy" | "requestPermission"
>;

export function subagentTools(): ToolDef[] {
  return [
    readTool, globTool, grepTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool
  ];
}

// Scans backwards for the newest assistant history entry and joins its text
// blocks — the subagent's "final answer".
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const blocks = m.content as Array<{ type: string; text?: string }>;
    return blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  }
  return "";
}

export async function runSubagent(
  deps: SubagentDeps,
  cwd: string,
  prompt: string,
  signal: AbortSignal
): Promise<ToolOutput> {
  const received: EngineMessage[] = [];
  const loop = new EngineLoop({
    client: deps.client(),
    model: deps.model(),
    systemPrompt: buildSubagentSystemPrompt(cwd),
    tools: subagentTools(),
    cwd,
    permissionMode: deps.permissionMode(),
    store: deps.store,
    lsp: deps.lsp,
    networkPolicy: deps.networkPolicy,
    effort: deps.effort(),
    contextWindow: deps.contextWindow?.(),
    maxTurns: SUBAGENT_MAX_TURNS,
    onMessage: m => received.push(m),
    requestPermission: deps.requestPermission
  });
  await loop.runTurn(prompt, signal);

  const last = received[received.length - 1];
  if (last?.type === "result" && last.subtype === "error_during_execution") {
    return { content: last.result, isError: true };
  }
  const hitCap = received.some(m => m.type === "limit" && m.limit === "maxTurns");
  if (hitCap) {
    const partial = lastAssistantText(loop.messages);
    const note = `[Exploration stopped after ${SUBAGENT_MAX_TURNS} turns without a final answer]`;
    return { content: partial !== "" ? `${note}\n\n${partial}` : note };
  }
  const text = lastAssistantText(loop.messages);
  if (text !== "") return { content: text };
  return {
    content: signal.aborted ? "Interrupted by user" : "(subagent produced no output)",
    isError: true
  };
}

export function createTaskTool(deps: TaskToolDeps): ToolDef {
  return {
    name: "Task",
    description:
      "Dispatch a read-only exploration subagent with its own context window. " +
      "It can Read/Glob/Grep and use LSP lookups, then reports its findings back.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short 3-5 word summary of the investigation (shown to the user)" },
        prompt: { type: "string", description: "Full instruction for the subagent: what to find and what to report" }
      },
      required: ["description", "prompt"]
    },
    execute(input, ctx) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (prompt === "") {
        return Promise.resolve({ content: "Task requires a prompt describing what to investigate.", isError: true });
      }
      return runSubagent(deps, ctx.cwd, prompt, ctx.signal ?? new AbortController().signal);
    }
  };
}
