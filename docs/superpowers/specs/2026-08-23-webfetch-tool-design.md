# webfetch Tool Design

Date: 2026-08-23

## Goal

Give the model a native `webfetch` tool so it can retrieve web content
(documentation pages, error references, raw files) during a turn. Scope is
deliberately fetch-only: no web search, no nested model summarization.

## Non-goals

- Web search (requires an external search API key; may be added later).
- Model-driven content extraction/summarization of fetched pages.
- Caching beyond a single run.

## Components and placement

Following the layering rules in AGENTS.md:

- **`src/engine/tools/webfetch.ts`** — the tool implementation, following the
  existing tool contract in `src/engine/tools/types.ts`. Registered in
  `src/engine/registry.ts`.
- **`src/engine/tools/htmlToMarkdown.ts`** — HTML-to-Markdown conversion as a
  standalone module wrapping the `turndown` library, so conversion is testable
  and replaceable without touching tool plumbing.
- **`src/agent/networkPolicy.ts`** — new `"webFetch"` value on the
  `NetworkCapability` union. The destination is validated through the same
  `parseDestination` / `normalizedHost` path used by other capabilities.
  `offlineStrict` and `providerOnly` modes deny it; only `unrestricted`
  allows outbound fetches. Denials are recorded via the existing
  `NetworkDecisionRecorder` audit path.
- **Permissions** — the tool participates in the standard permission flow like
  bash/edit: first use prompts; "always allow" persists in the permission
  store keyed by host.

## Tool behavior

Input schema:

```json
{ "url": "https://example.com/docs/page" }
```

Only `http:` and `https:` URLs are accepted; anything else is an input error.

Fetch semantics:

- Uses the global `fetch` with a 30-second timeout (`AbortSignal.timeout`) and
  a 5 MB response-body cap (enforced while reading, not after).
- Redirects are followed by default; the final URL is re-validated against
  network policy before its body is used.
- Content-Type dispatch:
  - `text/html` → converted to Markdown via `htmlToMarkdown`.
  - `text/plain`, `text/markdown`, and other `text/*` → returned as-is.
  - `application/json` → pretty-printed.
  - Everything else (binary) → error result naming the content type.
- Output larger than 50,000 characters is truncated to the limit with a
  trailing `[truncated N characters]` marker.

## Error handling

Per project convention there is no try/catch at call sites: a thrown error
becomes an `is_error` tool result through the per-tool boundary in
`engine/loop.ts` (`runTool`), and the turn continues. HTTP status codes are
mapped to human-readable messages (e.g. 404 → "not found", 403 → "forbidden")
before throwing.

## Testing

Same-commit tests per the testing convention:

- **`tests/engine-webfetch.test.ts`** — injects a mock fetch to cover:
  HTML→Markdown conversion, plain-text passthrough, JSON pretty-printing,
  binary rejection, truncation marker, timeout, non-http(s) scheme rejection,
  oversized response handling, and HTTP status mapping.
- **networkPolicy tests updated** — `webFetch` denied under
  `offlineStrict`/`providerOnly`, allowed under `unrestricted`, denial
  recorded.
- **registry tests updated** — tool appears with correct name/schema.

## Dependency

One new runtime dependency: `turndown` (plus `@types/turndown` as dev). CI's
`npm audit --audit-level=high` gate applies as usual.
