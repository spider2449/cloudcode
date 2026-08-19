import { join } from "node:path";
import { AgentSession, DEFAULT_MODEL, type PermissionMode } from "./agent/session.js";
import type { ProviderConfig } from "./agent/providers.js";
import { loadMcpServers } from "./agent/mcp.js";
import type { EffortLevel } from "./engine/effort.js";
import type { SessionIndex } from "./agent/sessionIndex.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "./agent/projectTrust.js";
import { loadRegistry } from "./engine/lsp/config.js";
import {
  NetworkPolicy, NetworkPolicyError, providerEndpoint,
  type NetworkDecisionRecorder, type NetworkMode
} from "./agent/networkPolicy.js";
import { RunLimitConfigurationError, RunLimitError, type RunLimits } from "./engine/runLimits.js";
import { PrintAdapter, type PrintAdapterIo } from "./print/adapter.js";
import { EXIT_CODES } from "./print/exitCodes.js";
import type { OutputFormat } from "./print/serialize.js";

export type PrintIo = PrintAdapterIo;

export interface InterruptSource {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
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
  outputFormat?: OutputFormat;
  runLimits?: RunLimits;
  interruptSource?: InterruptSource;
}

// One-shot non-interactive turn. All formats reuse AgentSession and the same
// engine/permission/checkpoint boundaries as the interactive TUI.
export async function runPrint(opts: PrintOptions, io: PrintIo): Promise<number> {
  const started = Date.now();
  const model = opts.model ?? opts.provider.model ?? DEFAULT_MODEL;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const adapter = new PrintAdapter({
    outputFormat: opts.outputFormat ?? "text",
    io,
    provider: opts.providerName,
    model,
    networkMode: opts.networkMode ?? "providerOnly",
    secrets: [opts.provider.apiKey, process.env.ANTHROPIC_API_KEY],
    audit: opts.networkAudit,
    onFinished: finish
  });
  adapter.start();

  const descriptor = inspectProjectExecutableConfig(opts.cwd);
  const includeProjectConfig = descriptor === undefined || opts.trustProjectConfig === true ||
    new ProjectTrustStore().isTrusted(descriptor);
  if (descriptor && !includeProjectConfig) {
    adapter.warn("Ignored untrusted project MCP/LSP configuration; pass --trust-project-config to allow it.");
  }

  const policy = new NetworkPolicy(
    opts.networkMode ?? "providerOnly", providerEndpoint(opts.provider), adapter
  );
  const session = new AgentSession({
    providerName: opts.providerName,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    cwd: opts.cwd,
    runLimits: opts.runLimits,
    networkPolicy: policy,
    mcpServers: loadMcpServers(opts.cwd, undefined, includeProjectConfig),
    lspRegistry: loadRegistry(undefined, join(opts.cwd, ".cloudcode", "lsp.json"), includeProjectConfig),
    onMessage: message => adapter.handleMessage(message),
    onPermissionRequest: request => adapter.resolvePermission(request),
    onSessionId: id => {
      adapter.setSessionId(id);
      opts.sessionIndex.record({
        id, cwd: opts.cwd, firstMessage: opts.prompt, timestamp: new Date().toISOString(),
        provider: opts.providerName
      });
    }
  });

  let interrupted = false;
  let wakeInterrupt!: () => void;
  const interrupt = new Promise<void>(resolve => { wakeInterrupt = resolve; });
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    adapter.markInterrupted();
    void session.interrupt();
    wakeInterrupt();
  };
  const interruptSource = opts.interruptSource ?? process;
  interruptSource.once("SIGINT", onSigint);

  try {
    session.start();
    const ready = await Promise.race([
      session.ready().then(() => true),
      interrupt.then(() => false)
    ]);
    if (ready && !interrupted) {
      session.send(opts.prompt);
      await done;
      // The session continuation persists transcript/checkpoint state after
      // the result callback. Yield once before reading final metadata.
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (err) {
    if (err instanceof NetworkPolicyError) adapter.fail(err.message, EXIT_CODES.networkDenied);
    else if (err instanceof RunLimitConfigurationError) adapter.fail(err.message, EXIT_CODES.invalidConfiguration);
    else if (err instanceof RunLimitError) {
      if (adapter.exitCode !== EXIT_CODES.limitReached) adapter.fail(err.message, EXIT_CODES.limitReached);
    } else adapter.fail(err instanceof Error ? err.message : String(err), EXIT_CODES.executionError);
  } finally {
    interruptSource.off("SIGINT", onSigint);
    await session.dispose();
  }

  const checkpoint = session.changeSummaries(true)[0];
  adapter.finalize({
    sessionId: session.sessionId,
    durationMs: Date.now() - started,
    provider: opts.providerName,
    model,
    ...(checkpoint ? { checkpoint: { id: checkpoint.id, changedFiles: checkpoint.changes.length } } : {})
  });
  return adapter.exitCode;
}

export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
