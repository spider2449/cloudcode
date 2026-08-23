import type { ProviderConfig } from "../agent/providers.js";
import {
  NetworkPolicy, bashNetworkStatus, providerEndpoint,
  type NetworkDecisionRecorder, type NetworkMode
} from "../agent/networkPolicy.js";

/** Owns the TUI's effective network mode and creates provider-scoped policies. */
export class NetworkController {
  constructor(
    private current: NetworkMode,
    private providers: Record<string, ProviderConfig>,
    private recorder?: NetworkDecisionRecorder
  ) {}

  get mode(): NetworkMode { return this.current; }

  setMode(mode: NetworkMode): void { this.current = mode; }

  policyFor(providerName: string): NetworkPolicy {
    const endpoint = providerEndpoint(this.providers[providerName] ?? {});
    return new NetworkPolicy(this.current, endpoint, this.recorder);
  }

  notice(): string {
    const bash = bashNetworkStatus(this.current, false);
    return `Network mode: ${this.current}. Bash networking: ${bash.description}. ` +
      "Policy covers cloudcode-owned egress; LSP and stdio MCP child processes are governed by project trust.";
  }
}
