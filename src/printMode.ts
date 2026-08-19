import { AgentSession, type PermissionMode } from "./agent/session.js";
import type { ProviderConfig } from "./agent/providers.js";
import { loadMcpServers } from "./agent/mcp.js";
import type { EffortLevel } from "./engine/effort.js";
import type { SessionIndex } from "./agent/sessionIndex.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "./agent/projectTrust.js";
import { loadRegistry } from "./engine/lsp/config.js";
import { join } from "node:path";
import {
  NetworkPolicy, NetworkPolicyError, providerEndpoint,
  type NetworkDecisionRecorder, type NetworkMode
} from "./agent/networkPolicy.js";

export interface PrintIo {
  out(text: string): void;
  err(text: string): void;
}

export interface PrintOptions {
  prompt: string;
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  resume?: string;
  cwd: string;
  sessionIndex: SessionIndex;
  trustProjectConfig?: boolean;
  networkMode?: NetworkMode;
  networkAudit?: NetworkDecisionRecorder;
}

// One-shot non-interactive turn: stream assistant text to stdout, summarize
// tool activity on stderr, auto-deny anything that would prompt. The session
// file still persists exactly as in interactive mode.
export async function runPrint(opts: PrintOptions, io: PrintIo): Promise<number> {
  let exitCode = 0;
  let lastChar = "\n";
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const descriptor = inspectProjectExecutableConfig(opts.cwd);
  const includeProjectConfig = descriptor === undefined || opts.trustProjectConfig === true || new ProjectTrustStore().isTrusted(descriptor);
  if (descriptor && !includeProjectConfig) {
    io.err("[warning] Ignored untrusted project MCP/LSP configuration; pass --trust-project-config to allow it.\n");
  }
  const policy = new NetworkPolicy(
    opts.networkMode ?? "providerOnly", providerEndpoint(opts.provider), opts.networkAudit
  );
  const session = new AgentSession({
    providerName: opts.providerName,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    cwd: opts.cwd,
    networkPolicy: policy,
    mcpServers: loadMcpServers(opts.cwd, undefined, includeProjectConfig),
    lspRegistry: loadRegistry(undefined, join(opts.cwd, ".cloudcode", "lsp.json"), includeProjectConfig),
    onMessage: msg => {
      if (msg.type === "stream_event") {
        if (msg.event.delta.type === "text_delta") {
          const text = msg.event.delta.text;
          if (text.length > 0) lastChar = text[text.length - 1];
          io.out(text);
        }
      } else if (msg.type === "assistant") {
        // Text was already streamed via deltas; only surface tool calls.
        for (const block of msg.message.content) {
          if (block.type === "tool_use") io.err(`[tool] ${block.name}\n`);
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "error_during_execution") {
          io.err(`${msg.result}\n`);
          exitCode = 1;
        }
        finish();
      }
    },
    onPermissionRequest: req => {
      io.err(`[denied] ${req.toolName} (non-interactive; pass --permission-mode acceptEdits or bypassPermissions to allow)\n`);
      req.resolve(false);
    },
    onSessionId: id => {
      opts.sessionIndex.record({
        id,
        cwd: opts.cwd,
        firstMessage: opts.prompt,
        timestamp: new Date().toISOString(),
        provider: opts.providerName
      });
    }
  });
  try {
    session.start();
  } catch (err) {
    if (err instanceof NetworkPolicyError) {
      io.err(`${err.message}\n`);
      return 7;
    }
    throw err;
  }
  await session.ready();
  session.send(opts.prompt);
  await done;
  // send() persists the transcript in a .then() that runs only after runTurn
  // resolves, which is after the result message that resolved `done`; yield
  // one macrotask so the session file is written before teardown.
  await new Promise(resolve => setImmediate(resolve));
  await session.dispose();
  if (lastChar !== "\n") io.out("\n");
  return exitCode;
}

export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
