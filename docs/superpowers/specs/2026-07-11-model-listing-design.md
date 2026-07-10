# Model Listing from Provider APIs — Design

**Date:** 2026-07-11
**Status:** Approved

## Problem

`/model` requires typing a model ID blind. Providers can enumerate their models:
OpenAI-compatible servers (llama-cpp) via `GET {baseUrl}/v1/models`, Anthropic via
`GET https://api.anthropic.com/v1/models`. cloudcode should fetch and surface that list.

## Behavior

- `/model` with no args prints the fetched model list, marking the currently selected
  model with `●`. If the list is unavailable (fetch failed or still in flight), fall back
  to the current usage text plus `(model list unavailable for this provider)`.
- `/model <prefix>` and `/config model <prefix>` tab-complete from the cached list.
- Typing a model ID not in the list remains allowed — lists can be stale, and Anthropic
  aliases (e.g. `claude-sonnet-5`) resolve even when not enumerated.
- The list is fetched fire-and-forget when a session is created (startup, `/clear`,
  provider switch, resume). Fetch failures are silent; completion is simply empty.

## Components

### `src/agent/models.ts` (new)

`fetchModels(provider: ProviderConfig, fetchFn = fetch): Promise<string[]>`

- Provider has `baseUrl` → `GET {baseUrl}/v1/models`, header
  `Authorization: Bearer <apiKey>` when `apiKey` is set.
- No `baseUrl` (anthropic) → `GET https://api.anthropic.com/v1/models`, headers
  `x-api-key: <provider.apiKey ?? process.env.ANTHROPIC_API_KEY>` and
  `anthropic-version: 2023-06-01`. If no key is available, resolve `[]` without a request.
- Both responses share the shape `{ data: [{ id: string }, ...] }`; return the `id`s.
- `AbortSignal.timeout(3000)`; any error, non-OK status, or malformed body resolves `[]`.
- `fetchFn` parameter exists for tests; production callers omit it.

### `App.tsx`

- `availableModelsRef: useRef<string[]>([])`, cleared then refreshed fire-and-forget in
  `createSession` via `fetchModels(props.providers[name])`.
- `CommandContext` and `CompletionContext` gain `availableModels(): string[]` returning
  the ref's contents.

### `builtins.ts`

- `/model` no-arg: list from `ctx.availableModels()` with `●` on the current model
  (context gains `currentModel(): string | undefined`), fallback described above.
- `/model` gains `completeArgs` filtering `availableModels()` by prefix.
- `/config`'s `completeArgs` uses `availableModels()` for the `model` key (currently
  hardcoded `[]`).

## Error handling

No retries, no user-facing errors from the background fetch. The next session creation
refetches. A 3-second timeout keeps a dead llama-cpp server from delaying anything
(the fetch is off the critical path regardless).

## Testing

- `tests/models.test.ts`: URL and headers for both provider shapes; bearer header only
  when apiKey set; anthropic with no key short-circuits to `[]`; malformed body, non-OK
  status, and network error all resolve `[]`.
- `tests/commands.test.ts`: `/model` no-arg lists models with current marked; fallback
  text when list empty; `/model` and `/config model` completion filter by prefix.
- `tests/app.test.tsx`: session creation populates the model list and it reaches the
  completion context (via a stubbed `fetchModels`).

## Out of scope

Manual refresh command, list caching across restarts, filtering Anthropic's list to
chat-capable models, and provider-specific pagination (both APIs return one page for
realistic model counts).
