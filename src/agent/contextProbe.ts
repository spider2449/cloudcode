import type { ProviderConfig } from "./providers.js";

// One probe result per server per process. Failures are cached too so an
// unreachable server never adds latency twice.
const cache = new Map<string, number | undefined>();

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function detectContextWindow(
  provider: ProviderConfig,
  fetchFn: typeof fetch = fetch
): Promise<number | undefined> {
  if (!provider.baseUrl) return undefined;
  try {
    // /props reports the server's allocated context (-c), unlike
    // /v1/models meta which reflects model hparams. Newer builds nest
    // n_ctx under default_generation_settings; older ones expose it top level.
    const res = await fetchFn(`${trimBase(provider.baseUrl)}/props`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = await res.json();
    const nested = (body as { default_generation_settings?: { n_ctx?: unknown } }).default_generation_settings?.n_ctx;
    const top = (body as { n_ctx?: unknown }).n_ctx;
    return asPositiveInt(nested) ?? asPositiveInt(top);
  } catch {
    // background probe: context detection is best-effort
    return undefined;
  }
}

export async function applyContextWindow(
  provider: ProviderConfig | undefined,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (!provider || provider.kind !== "openai" || provider.model_context_window !== undefined) return;
  const key = trimBase(provider.baseUrl ?? "");
  const cached = cache.get(key);
  if (cached !== undefined) {
    provider.model_context_window = cached;
    return;
  }
  if (cache.has(key)) return;
  const detected = await detectContextWindow(provider, fetchFn);
  cache.set(key, detected);
  if (detected !== undefined) provider.model_context_window = detected;
}
