/** Owns the queue of messages submitted while a turn was in flight; drained
 * FIFO, one message per drain, when the agent returns to idle. */
export class InputQueue {
  private messages: string[] = [];

  get size(): number {
    return this.messages.length;
  }

  /** Read-only snapshot for rendering the queued-rows footer. */
  items(): readonly string[] {
    return this.messages;
  }

  enqueue(text: string): void {
    this.messages.push(text);
  }

  /** If idle with pending queued messages, submit the next one. */
  drainIfIdle(isIdle: () => boolean, submit: (text: string) => void): void {
    if (!isIdle() || this.messages.length === 0) return;
    const next = this.messages.shift();
    if (next !== undefined) submit(next);
  }
}
