# Design: llama.cpp context window auto-detection

Date: 2026-08-23

## Problem

For OpenAI-compatible providers (local llama.cpp, etc.), `model_context_window`
in `~/.cloudcode/providers.json` is manual. When unset, cloudcode assumes
`DEFAULT_CONTEXT_WINDOW` (200k), which is wrong for most local models and
skews auto-compact thresholds, effort headroom clamping (`engine/loop.ts`),
and the context-usage meter (`ui/usageTracker.ts`).

llama.cpp's server exposes the in-use context size at `GET /props`
(`default_generation_settings.n_ctx`; some builds also expose a top-level
`n_ctx`). Verified against a live server (build b10549): only
`default_generation_settings.n_ctx` is present there; top-level `n_ctx`
exists on other builds.

## Goal

Auto-detect the effective context window from a llama.cpp server at startup
and use it whenever `model_context_window` is not manually configured. A
manual value always wins. Detection is best-effort: any failure falls back
silently.

## Non-goals

- No write-back to `providers.json`.
- No probing of Anthropic-kind providers.
- No use of `/v1/models` (`meta.n_ctx` reflects model hparams, not the
  server's allocated `-c` value, so `/props` is the authoritative source for
  the in-use size).
- The chat `model` string does not need to match the server's GGUF path;
  detection is per-server (base URL), not per-model.

## Component: `src/agent/contextProbe.ts`

```ts
export async function detectContextWindow(cfg: ProviderConfig): Promise<number | undefined>
```

- `GET {cfg.baseUrl}/props` with an `AbortController` timeout of 2 seconds.
- Parse order: `json.default_generation_settings.n_ctx`, then top-level
  `json.n_ctx`. Accept only finite positive integers.
- Return `undefined` on any failure (non-JSON body, missing fields, HTTP
  error, abort). Never throws.
- Callers only invoke this for `kind === "openai"` providers.

Placement follows AGENTS.md: this is provider/machine configuration
discovery, i.e. the `agent/` layer.

## Integration

Context window flows from `provider.model_context_window` into
session → loop → UI (`agent/session.ts`, `ui/sessionPresentation.ts`). The
probe therefore patches the provider object at its source; no downstream
changes needed.

1. **Startup** (`src/cli.tsx`, where providers are loaded and one is
   selected): if the selected provider has `kind === "openai"` and no
   `model_context_window`, `await detectContextWindow(provider)` before the
   app launches and assign the result to the in-memory provider object.
   The await happens before UI start; worst case adds ~2s when the server
   is unreachable (timeout then silent fallback).
2. **Provider switch** (`src/ui/nativeApp.ts`, where sessions are created
   from `providers[name]`): same rule, memoized by base URL so one server
   is probed at most once per process.

Memoization lives inside `contextProbe.ts`
(`detectContextWindowCached(cfg)` keyed by base URL with trailing slashes
trimmed) so both call sites share it.

## Error handling

No new try/catch beyond the probe itself — `detectContextWindow` catches all
its own errors and returns `undefined`, matching the self-wrapping convention
of on-disk config loaders. Downstream code keeps using
`DEFAULT_CONTEXT_WINDOW` via the existing fallback chain.

## Testing

- `tests/contextProbe.test.ts`: mock fetch covering
  - `default_generation_settings.n_ctx` parsed (live-build shape),
  - top-level `n_ctx` parsed (older-build shape),
  - non-integer / zero / negative values rejected,
  - 404, malformed JSON, timeout, and network rejection → `undefined`,
  - memoization: second call with same base URL does not refetch,
  - manual `model_context_window` precedence belongs to callers, asserted
    in caller tests below.
- Existing cli/nativeApp test files gain cases: detected value applied when
  unset; manual value kept without probing.

## Size/lint impact

One new module (~60 lines) plus tests. No existing file approaches the 600-line ceiling from this change.
