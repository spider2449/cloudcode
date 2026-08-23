// Canonical segment list for the configurable status line. Deliberately
// import-free so both src/agent (settings validation) and src/ui (rendering,
// overlay) can depend on it without crossing layers.

export const STATUS_LINE_ITEMS = [
  "model",
  "servedModel",
  "effort",
  "mode",
  "network",
  "branch",
  "tokens",
  "cost",
  "elapsed",
  "cwd"
] as const;

export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

export const DEFAULT_STATUS_LINE_ITEMS: StatusLineItem[] = ["model", "mode", "branch", "tokens"];

export const STATUS_LINE_LABELS: Record<StatusLineItem, string> = {
  model: "Provider / model",
  servedModel: "Served model override",
  effort: "Reasoning effort",
  mode: "Permission mode",
  network: "Network mode",
  branch: "Git branch",
  tokens: "Token usage / context %",
  cost: "Session cost",
  elapsed: "Elapsed time",
  cwd: "Working directory"
};

const KNOWN: readonly string[] = STATUS_LINE_ITEMS;

/** Valid string arrays become a deduped known-ID list (empty allowed);
 * everything else is invalid and the caller falls back to defaults. */
export function normalizeStatusLineItems(value: unknown): StatusLineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: StatusLineItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !KNOWN.includes(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry as StatusLineItem);
  }
  return out;
}

export function canonicalOrder(enabled: Set<StatusLineItem>): StatusLineItem[] {
  return STATUS_LINE_ITEMS.filter(item => enabled.has(item));
}
