import { commandPrefix, type PermissionStore } from "../agent/permissionStore.js";
import { hostScope, ruleScope } from "../engine/permissions.js";
import type { PermissionRequest } from "../agent/session.js";
import type { OverlayManager } from "./widgets/overlay.js";

export interface PermissionControllerDeps {
  overlay: OverlayManager;
  store: PermissionStore;
  onError(text: string): void;
  /** Called once the last queued request has been answered. */
  onQueueEmpty(): void;
  recompute(): void;
}

/**
 * Owns the queue of pending tool-permission requests and the overlay that
 * answers them. Requests arrive one per tool call and are answered strictly in
 * order: only the head of the queue is ever shown, and the next one opens as
 * soon as it is decided.
 */
export class PermissionController {
  private queue: PermissionRequest[] = [];

  constructor(private deps: PermissionControllerDeps) {}

  enqueue(request: PermissionRequest): void {
    this.queue.push(request);
    this.openNext();
  }

  private openNext(): void {
    const active = this.queue[0];
    if (!active) return;
    this.deps.overlay.openPermission(active, (allow, rememberAs) => this.decide(allow, rememberAs));
    this.deps.recompute();
  }

  private decide(allow: boolean, rememberAs?: "allow" | "deny"): void {
    const active = this.queue[0];
    if (rememberAs && active) {
      try {
        const host = hostScope(active.toolName, active.input);
        if (host) {
          this.deps.store.rememberHost(active.toolName, host, rememberAs);
        } else {
          const scope = ruleScope(active.toolName, active.input);
          if (scope) {
            // "dir" inputs (Glob/Grep) already name the directory to scope to;
            // "file" inputs are scoped to their containing directory.
            if (scope.kind === "dir") this.deps.store.rememberDir(active.toolName, scope.path, rememberAs);
            else this.deps.store.remember(active.toolName, scope.path, rememberAs);
          } else if (active.toolName === "Bash" && typeof active.input.command === "string") {
            this.deps.store.rememberCommand(commandPrefix(String(active.input.command)), rememberAs);
          }
        }
      } catch (err) {
        // The in-memory rule still applies; only persisting failed.
        this.deps.onError(`Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    active?.resolve(allow);
    this.queue = this.queue.slice(1);
    if (this.queue.length === 0) this.deps.onQueueEmpty();
    else this.openNext();
    this.deps.recompute();
  }
}
