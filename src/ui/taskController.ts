import type { EngineMessage } from "../engine/messages.js";

export interface TaskUiOptions {
  initialPrompt?: string;
  planning: boolean;
  toolAllowlist?: readonly string[];
  disableMcp?: boolean;
  onSessionId?(id: string): void;
  onPlanningComplete?(sessionId?: string): void;
  onTurnComplete?(sessionId?: string): void;
}

export class TaskUiController {
  private sessionId: string | undefined;
  private initialTaken = false;
  private planningPending: boolean;
  private completionReported = false;

  constructor(private options?: TaskUiOptions) {
    this.planningPending = options?.planning === true;
  }

  sessionStarted(id: string): void {
    this.sessionId = id;
    this.options?.onSessionId?.(id);
  }

  takeInitialPrompt(): string | undefined {
    if (this.initialTaken) return undefined;
    this.initialTaken = true;
    return this.options?.initialPrompt;
  }

  handleMessage(message: EngineMessage, onError: (message: string) => void): void {
    if (message.type !== "result") return;
    try {
      if (this.planningPending) {
        this.planningPending = false;
        this.options?.onPlanningComplete?.(this.sessionId);
      }
      if (!this.completionReported && this.options?.onTurnComplete) {
        this.completionReported = true;
        this.options.onTurnComplete(this.sessionId);
      }
    }
    catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  }
}
