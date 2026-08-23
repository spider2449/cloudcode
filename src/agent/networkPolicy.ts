import type { ProviderConfig } from "./providers.js";

export type NetworkMode = "offlineStrict" | "providerOnly" | "unrestricted";
export type PersistedNetworkMode = Exclude<NetworkMode, "unrestricted">;

export type NetworkCapability =
  | "provider"
  | "mcpHttp"
  | "update"
  | "skillRepo"
  | "gitRemote"
  | "packInstaller"
  | "webFetch";

export type NetworkDenialReason =
  | "invalidDestination"
  | "nonLoopbackProvider"
  | "capabilityDenied"
  | "notSelectedProvider";

export interface NetworkRequest {
  capability: NetworkCapability;
  destination: string;
}

export interface NetworkDecision {
  capability: NetworkCapability;
  destinationHost: string;
  mode: NetworkMode;
  allowed: boolean;
  reason?: NetworkDenialReason;
}

export interface NetworkDecisionRecorder {
  record(decision: NetworkDecision): void;
}

export const NETWORK_MODES: readonly NetworkMode[] = [
  "offlineStrict", "providerOnly", "unrestricted"
];

const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

function parseDestination(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (host.startsWith("::ffff:")) return isLoopbackHost(host.slice("::ffff:".length));
  const octets = host.split(".");
  return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

export function isLoopbackUrl(value: string): boolean {
  const url = parseDestination(value);
  return url !== undefined && isLoopbackHost(url.hostname);
}

export function providerEndpoint(provider: ProviderConfig): string {
  return provider.baseUrl ?? DEFAULT_ANTHROPIC_URL;
}

export function isNetworkMode(value: unknown): value is NetworkMode {
  return typeof value === "string" && NETWORK_MODES.includes(value as NetworkMode);
}

export function isPersistedNetworkMode(value: unknown): value is PersistedNetworkMode {
  return value === "offlineStrict" || value === "providerOnly";
}

export function effectiveNetworkMode(
  persisted: PersistedNetworkMode | undefined,
  requested: NetworkMode | undefined
): NetworkMode {
  const saved = persisted ?? "providerOnly";
  if (requested === undefined) return saved;
  // unrestricted is never persisted: spelling it on this invocation is the
  // deliberate, visible acknowledgement required to widen egress temporarily.
  if (requested === "unrestricted") return requested;
  if (saved === "offlineStrict" && requested === "providerOnly") {
    throw new Error("--network-mode providerOnly cannot widen saved offlineStrict policy; change /config networkMode first.");
  }
  return requested;
}

export function decideNetwork(
  mode: NetworkMode,
  request: NetworkRequest,
  selectedProviderDestination?: string
): NetworkDecision {
  const url = parseDestination(request.destination);
  const base: Omit<NetworkDecision, "allowed"> = {
    capability: request.capability,
    destinationHost: url ? normalizedHost(url) : "(invalid)",
    mode
  };
  if (!url) return { ...base, allowed: false, reason: "invalidDestination" };
  if (mode === "unrestricted") return { ...base, allowed: true };

  if (request.capability !== "provider") {
    return { ...base, allowed: false, reason: "capabilityDenied" };
  }
  if (mode === "offlineStrict" && !isLoopbackHost(url.hostname)) {
    return { ...base, allowed: false, reason: "nonLoopbackProvider" };
  }
  if (selectedProviderDestination) {
    const selected = parseDestination(selectedProviderDestination);
    if (!selected || selected.origin !== url.origin) {
      return { ...base, allowed: false, reason: "notSelectedProvider" };
    }
  }
  return { ...base, allowed: true };
}

export class NetworkPolicy {
  private currentMode: NetworkMode;

  constructor(
    mode: NetworkMode,
    private selectedProviderDestination?: string,
    private recorder?: NetworkDecisionRecorder
  ) {
    this.currentMode = mode;
  }

  /** Live view: setMode() lets an already-running session widen or narrow. */
  get mode(): NetworkMode { return this.currentMode; }

  setMode(mode: NetworkMode): void { this.currentMode = mode; }

  decide(request: NetworkRequest): NetworkDecision {
    const mode = this.currentMode;
    const decision = decideNetwork(mode, request, this.selectedProviderDestination);
    this.recorder?.record(decision);
    return decision;
  }

  require(request: NetworkRequest): void {
    const decision = this.decide(request);
    if (!decision.allowed) {
      throw new NetworkPolicyError(decision);
    }
  }
}

export class NetworkPolicyError extends Error {
  readonly code = "NETWORK_POLICY_DENIED";

  constructor(readonly decision: NetworkDecision) {
    super(`Network policy ${decision.mode} denied ${decision.capability} access to ${decision.destinationHost} (${decision.reason}).`);
    this.name = "NetworkPolicyError";
  }
}

export function bashNetworkStatus(mode: NetworkMode, verifiedNoNetworkSandbox: boolean): {
  available: boolean;
  description: "contained" | "uncontained" | "disabled";
} {
  if (mode === "offlineStrict") {
    return verifiedNoNetworkSandbox
      ? { available: true, description: "contained" }
      : { available: false, description: "disabled" };
  }
  return { available: true, description: "uncontained" };
}
