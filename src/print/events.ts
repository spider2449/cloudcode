import type { ContentBlock, Usage } from "../engine/messages.js";
import type { NetworkDecision } from "../agent/networkPolicy.js";
import type { RunLimitKind } from "../engine/runLimits.js";

export interface RunResultMetadata {
  sessionId?: string;
  durationMs: number;
  provider: string;
  model: string;
  usage?: Usage;
  costUsd?: number;
  checkpoint?: { id: string; changedFiles: number };
  finishReason: "completed" | "error" | "limit" | "interrupted";
  exitCode: number;
}

export type AutomationEvent =
  | { kind: "run.started"; provider: string; model: string; networkMode: string }
  | ({ kind: "run.finished" } & RunResultMetadata)
  | { kind: "assistant.text_delta"; text: string }
  | { kind: "assistant.message"; content: ContentBlock[] }
  | { kind: "tool.started"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool.finished"; toolUseId: string; content: unknown; isError: boolean }
  | { kind: "permission.requested"; toolUseId?: string; name: string; input: Record<string, unknown> }
  | { kind: "permission.resolved"; toolUseId?: string; name: string; allowed: boolean }
  | { kind: "limit.reached"; limit: RunLimitKind; value: number }
  | ({ kind: "network.decision" } & NetworkDecision)
  | { kind: "checkpoint.completed"; checkpointId: string; changedFiles: number }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };

export interface EventEnvelope<T extends AutomationEvent = AutomationEvent> {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId?: string;
  taskId?: string;
  event: T;
}

export interface EventSequencerOptions {
  now?: () => Date;
  onEvent?: (event: EventEnvelope) => void;
}

export class EventSequencer {
  private sequence = 0;
  private sessionId: string | undefined;
  private now: () => Date;
  private onEvent: ((event: EventEnvelope) => void) | undefined;

  constructor(options: EventSequencerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  setSessionId(id: string): void { this.sessionId = id; }

  emit<T extends AutomationEvent>(event: T, taskId?: string): EventEnvelope<T> {
    const envelope: EventEnvelope<T> = {
      schemaVersion: 1,
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(taskId ? { taskId } : {}),
      event
    };
    this.onEvent?.(envelope);
    return envelope;
  }
}

export function redactStructuredError(message: string, secrets: Array<string | undefined>): string {
  let redacted = message.replace(/(authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED_SECRET]");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED_SECRET]");
  }
  return redacted;
}
