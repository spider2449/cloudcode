import type { ProviderConfig } from "./providers.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/models";

// Both the OpenAI-compatible and Anthropic model endpoints return
// { data: [{ id: string }, ...] }.
function parseIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(entry => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function fetchModels(
  provider: ProviderConfig,
  fetchFn: typeof fetch = fetch
): Promise<string[]> {
  let url: string;
  const headers: Record<string, string> = {};
  if (provider.baseUrl) {
    // Providers like NVIDIA NIM include /v1 in the baseUrl already; avoid
    // producing a doubled /v1/v1/models path.
    const base = provider.baseUrl.replace(/\/$/, "");
    url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  } else {
    const key = provider.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return [];
    url = ANTHROPIC_URL;
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    return parseIds(await res.json());
  } catch {
    // background fetch: model listing is best-effort
    return [];
  }
}
