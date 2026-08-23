import type { ProviderConfig } from "../agent/providers.js";
import {
  NetworkPolicy, bashNetworkStatus, providerEndpoint,
  type NetworkDecisionRecorder, type NetworkMode
} from "../agent/networkPolicy.js";
import { sandboxEnablesBash } from "../agent/sandbox.js";

/** Owns the TUI's effective network mode and creates provider-scoped policies.
 * Policies are cached per provider so instances already held by a running
 * session follow setMode() instead of keeping the startup snapshot. */
export class NetworkController {
  private policies = new Map<string, NetworkPolicy>();

  constructor(
    private current: NetworkMode,
    private providers: Record<string, ProviderConfig>,
    private recorder?: NetworkDecisionRecorder,
    private bashVerified?: boolean
  ) {}

  get mode(): NetworkMode { return this.current; }

  setMode(mode: NetworkMode): void {
    this.current = mode;
    for (const policy of this.policies.values()) policy.setMode(mode);
  }

  policyFor(providerName: string): NetworkPolicy {
    let policy = this.policies.get(providerName);
    if (!policy) {
      policy = new NetworkPolicy(
        this.current,
        providerEndpoint(this.providers[providerName] ?? {}),
        this.recorder
      );
      this.policies.set(providerName, policy);
    }
    return policy;
  }

  notice(): string {
    const bash = bashNetworkStatus(this.current, this.bashVerified ?? sandboxEnablesBash(this.current));
    return `Network mode: ${this.current}. Bash networking: ${bash.description}. ` +
      "Policy covers cloudcode-owned egress; LSP and stdio MCP child processes are governed by project trust.";
  }
}
