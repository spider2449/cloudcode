import type { PermissionRequest } from "../agent/session.js";
import type { NetworkDecision, NetworkDecisionRecorder } from "../agent/networkPolicy.js";
import type { EngineMessage, Usage } from "../engine/messages.js";
import { EXIT_CODES } from "./exitCodes.js";
import {
  EventSequencer, redactStructuredError, type EventEnvelope, type RunResultMetadata
} from "./events.js";
import { serializeEvent, serializeJsonRun, type OutputFormat } from "./serialize.js";

export interface PrintAdapterIo {
  out(text: string): void;
  err(text: string): void;
}

export interface PrintAdapterOptions {
  outputFormat: OutputFormat;
  io: PrintAdapterIo;
  provider: string;
  model: string;
  networkMode: string;
  secrets: Array<string | undefined>;
  audit?: NetworkDecisionRecorder;
  onFinished(): void;
}

export class PrintAdapter implements NetworkDecisionRecorder {
  readonly events: EventEnvelope[] = [];
  readonly sequencer: EventSequencer;
  exitCode: number = EXIT_CODES.success;
  usage: Usage | undefined;
  costUsd: number | undefined;
  engineDurationMs = 0;
  private lastChar = "\n";
  private finishReason: RunResultMetadata["finishReason"] = "completed";

  constructor(private options: PrintAdapterOptions) {
    this.sequencer = new EventSequencer({ onEvent: event => {
      this.events.push(event);
      if (this.options.outputFormat === "stream-json") this.options.io.out(serializeEvent(event));
    } });
  }

  start(): void {
    this.sequencer.emit({
      kind: "run.started", provider: this.options.provider, model: this.options.model,
      networkMode: this.options.networkMode
    });
  }

  setSessionId(id: string): void { this.sequencer.setSessionId(id); }

  record(decision: NetworkDecision): void {
    this.options.audit?.record(decision);
    this.sequencer.emit({ kind: "network.decision", ...decision });
    if (!decision.allowed) {
      this.exitCode = EXIT_CODES.networkDenied;
      this.finishReason = "error";
      if (this.options.outputFormat === "text") {
        this.options.io.err(
          `[denied] network ${decision.capability} -> ${decision.destinationHost} (${decision.mode}/${decision.reason})\n`
        );
      }
    }
  }

  handleMessage(message: EngineMessage): void {
    if (message.type === "system") {
      this.setSessionId(message.session_id);
      return;
    }
    if (message.type === "stream_event") {
      if (message.event.delta.type !== "text_delta") return;
      const text = message.event.delta.text;
      this.sequencer.emit({ kind: "assistant.text_delta", text });
      if (this.options.outputFormat === "text") {
        if (text.length > 0) this.lastChar = text.at(-1) ?? this.lastChar;
        this.options.io.out(text);
      }
      return;
    }
    if (message.type === "assistant") {
      this.sequencer.emit({ kind: "assistant.message", content: message.message.content });
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        this.sequencer.emit({
          kind: "tool.started", toolUseId: block.id, name: block.name, input: block.input
        });
        if (this.options.outputFormat === "text") this.options.io.err(`[tool] ${block.name}\n`);
      }
      return;
    }
    if (message.type === "tool_result") {
      this.sequencer.emit({
        kind: "tool.finished", toolUseId: message.tool_use_id,
        content: message.content, isError: message.is_error
      });
      return;
    }
    if (message.type === "limit") {
      this.sequencer.emit({ kind: "limit.reached", limit: message.limit, value: message.value });
      this.exitCode = EXIT_CODES.limitReached;
      this.finishReason = "limit";
      return;
    }
    if (message.type !== "result") return;
    if (message.subtype === "error_during_execution") {
      const error = redactStructuredError(message.result, this.options.secrets);
      this.sequencer.emit({ kind: "error", message: error });
      if (this.options.outputFormat === "text") this.options.io.err(`${error}\n`);
      this.exitCode = EXIT_CODES.executionError;
      this.finishReason = "error";
    } else {
      this.usage = message.usage;
      this.costUsd = message.total_cost_usd;
      this.engineDurationMs = message.duration_ms;
      if (message.finish_reason === "limit") {
        this.exitCode = EXIT_CODES.limitReached;
        this.finishReason = "limit";
      } else if (message.finish_reason === "interrupted") {
        this.exitCode = EXIT_CODES.interrupted;
        this.finishReason = "interrupted";
      }
    }
    this.options.onFinished();
  }

  resolvePermission(request: PermissionRequest): void {
    this.sequencer.emit({ kind: "permission.requested", name: request.toolName, input: request.input });
    if (this.options.outputFormat === "text") {
      this.options.io.err(
        `[denied] ${request.toolName} (non-interactive; pass --permission-mode acceptEdits or bypassPermissions to allow)\n`
      );
    }
    this.sequencer.emit({ kind: "permission.resolved", name: request.toolName, allowed: false });
    this.exitCode = EXIT_CODES.permissionDenied;
    this.finishReason = "error";
    request.resolve(false);
  }

  fail(message: string, exitCode: number): void {
    const error = redactStructuredError(message, this.options.secrets);
    this.sequencer.emit({ kind: "error", message: error });
    if (this.options.outputFormat === "text") this.options.io.err(`${error}\n`);
    this.exitCode = exitCode;
    this.finishReason = exitCode === EXIT_CODES.interrupted ? "interrupted"
      : exitCode === EXIT_CODES.limitReached ? "limit" : "error";
  }

  warn(message: string): void {
    this.sequencer.emit({ kind: "warning", message });
    if (this.options.outputFormat === "text") this.options.io.err(`[warning] ${message}\n`);
  }

  markInterrupted(): void {
    this.exitCode = EXIT_CODES.interrupted;
    this.finishReason = "interrupted";
  }

  finalize(base: Omit<RunResultMetadata, "usage" | "costUsd" | "finishReason" | "exitCode">): RunResultMetadata {
    const result: RunResultMetadata = {
      ...base,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
      finishReason: this.finishReason,
      exitCode: this.exitCode
    };
    if (base.checkpoint) {
      this.sequencer.emit({
        kind: "checkpoint.completed", checkpointId: base.checkpoint.id,
        changedFiles: base.checkpoint.changedFiles
      });
    }
    this.sequencer.emit({ kind: "run.finished", ...result });
    if (this.options.outputFormat === "json") this.options.io.out(serializeJsonRun(this.events, result));
    if (this.options.outputFormat === "text" && this.lastChar !== "\n") this.options.io.out("\n");
    return result;
  }
}
