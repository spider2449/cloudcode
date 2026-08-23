# Claude.ai OAuth login design

Date: 2026-08-23

## Goal

Let users authenticate with their Claude.ai subscription instead of an
`ANTHROPIC_API_KEY`, via the (reverse-engineered, unofficial) Claude Code
OAuth flow: Authorization Code + PKCE, manual paste callback. Also reuse an
existing `~/.claude/.credentials.json` read-only when present.

**Known risk, accepted deliberately:** the flow is undocumented; Anthropic can
change endpoints or restrict third-party use of the shared client id at any
time. Header details differ between sources and must be verified empirically.

## Decisions

- **Target: claude.ai only** (Pro/Max subscribers). API-key users unaffected.
- **Callback: manual paste only.** No local HTTP server; works over SSH.
- **Credential chain:** explicit apiKey → cloudcode OAuth creds →
  `~/.claude/.credentials.json` (read-only) → current `"none"` behavior.
- Endpoints: authorize `https://claude.ai/oauth/authorize`
  (`code=true&response_type=code&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https://console.anthropic.com/oauth/code/callback&scope=org:create_api_key user:profile user:inference&code_challenge=…&code_challenge_method=S256&state=<verifier>`),
  token/refresh `https://console.anthropic.com/v1/oauth/token`.
- Pasted code accepts both `CODE` and `CODE#STATE`.

## Components

### `src/agent/oauth.ts` (agent layer)

PKCE primitives (verifier = base64url(32 random bytes), challenge =
S256(verifier) base64url, state = verifier); `buildAuthorizeUrl`,
`exchangeCode`, `refreshTokens`; tolerant credential store at
`<configBase>/credentials.json` storing
`{ claudeAiOauth: { accessToken, refreshToken?, expiresAt, scopes } }`
(chmod 0600 on POSIX; malformed file = not logged in). Read-only borrow of
`~/.claude/.credentials.json` when cloudcode's own credentials are absent;
never writes that file.

### `src/commands/cli/login.ts`

`cloudcode login | logout | status`. Login prints the URL (and opens the
browser), reads the pasted code via readline, exchanges, saves, prints expiry.
Logout deletes cloudcode's own credentials.

### `src/engine/api.ts` auth chain

In the anthropic branch of `makeClient`: explicit key as today; otherwise
resolve OAuth credentials (refreshing when within 60 s of expiry, atomic
rewrite) and construct the SDK with `authToken` (Bearer) plus
`defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }`; else unchanged
`"none"`.

### doctor

Reports the auth source (apiKey / oauth / none) and expiry.

## Network policy interaction

Token exchange/refresh is cloudcode-owned egress to a fixed destination:
add capability `"oauth"`, recorded in the audit log. Under `providerOnly` the
roadmap contract permits exactly the selected provider endpoint, so `login`
and session-time refresh are DENIED with guidance to re-run under
`--network-mode unrestricted` (one-shot, visible, never persisted). No silent
bypass.

## Error handling

Non-2xx exchange → show status, store nothing. Failed refresh → treat as not
logged in with a re-run-login hint. Tokens never appear in logs or error
messages. Malformed `~/.claude` file → silent skip.

## Testing

Injected fake fetch; no real network in tests:

- `tests/oauth.test.ts`: PKCE vectors, URL parameters, code parsing
  (`CODE` / `CODE#STATE`), exchange/refresh success + HTTP failure,
  credential round-trip, malformed-file tolerance, ~/.claude borrowing.
- `tests/engine-api-auth.test.ts`: chain order (apiKey wins), Bearer +
  beta header on OAuth, expiry triggers refresh.
- `tests/cliLogin.test.ts`: login/status/logout flows with injected readline.

Docs: rewrite the README sentence claiming Claude Code login reuse is
unsupported.
