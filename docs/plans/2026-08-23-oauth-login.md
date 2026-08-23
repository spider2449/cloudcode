# Claude.ai OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users log in with their Claude.ai subscription via the PKCE flow (`cloudcode login`), reuse `~/.claude/.credentials.json` read-only, and authenticate API calls with a Bearer token instead of an API key.

**Architecture:** New agent-layer module `src/agent/oauth.ts` owns PKCE, endpoint URLs, exchange/refresh (injectable fetch), and the tolerant credential store. The engine's `makeClient` gains an optional auth parameter threaded from the CLI through `AgentSessionOptions`. Network capability `"oauth"` joins the existing egress registry so `providerOnly` keeps denying it honestly.

**Tech Stack:** TypeScript (strict), node:crypto, vitest (injected fake fetch — no real network).

## Global Constraints

- All code, comments, identifiers in English.
- No `any`, no non-null `!`; strict stays true.
- Tokens never appear in logs, notices, or error messages.
- Never write to `~/.claude/**`; borrowing is read-only.
- Malformed credential files mean "not logged in" — never crash startup.
- Every production change ships its focused test in the same commit.
- Final gates: `npm run lint && npm run lint:size && npm run build && npm test`.

---

### Task 1: PKCE, URLs, code parsing

**Files:**
- Create: `src/agent/oauth.ts`
- Test: `tests/oauth.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–5):
  - `interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: number; scopes?: string[] }`
  - `generateVerifier(): string`; `challengeFor(verifier: string): string`
  - `buildAuthorizeUrl(verifier: string): string`
  - `parsePastedCode(input: string): { code: string; state?: string }`
  - constants: `OAUTH_CLIENT_ID`, `AUTHORIZE_ENDPOINT`, `TOKEN_ENDPOINT`

- [ ] **Step 1: Write the failing tests**

Create `tests/oauth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generateVerifier, challengeFor, buildAuthorizeUrl, parsePastedCode,
  OAUTH_CLIENT_ID, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT
} from "../src/agent/oauth.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("oauth primitives", () => {
  it("verifiers are 43-char unpadded base64url strings", () => {
    const v = generateVerifier();
    expect(v).toMatch(/^[\w-]{43}$/);
  });

  it("challenge is base64url SHA-256 of the verifier", () => {
    const v = generateVerifier();
    const expected = base64url(createHash("sha256").update(v).digest());
    expect(challengeFor(v)).toBe(expected);
  });

  it("authorize URL carries the required parameters", () => {
    const url = new URL(buildAuthorizeUrl("verifier-value"));
    expect(url.toString().startsWith(AUTHORIZE_ENDPOINT)).toBe(true);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.anthropic.com/oauth/code/callback");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challengeFor("verifier-value"));
    expect(url.searchParams.get("state")).toBe("verifier-value");
  });

  it("parses pasted codes with and without #state", () => {
    expect(parsePastedCode("abc123")).toEqual({ code: "abc123" });
    expect(parsePastedCode("abc123#state456")).toEqual({ code: "abc123", state: "state456" });
    expect(parsePastedCode("  abc123  ")).toEqual({ code: "abc123" });
  });

  it("exposes the documented endpoints", () => {
    expect(AUTHORIZE_ENDPOINT).toBe("https://claude.ai/oauth/authorize");
    expect(TOKEN_ENDPOINT).toBe("https://console.anthropic.com/v1/oauth/token");
  });
});
```

Run: `npx vitest run tests/oauth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

Create `src/agent/oauth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

// Reverse-engineered Claude Code OAuth flow. Unofficial: Anthropic may
// change these endpoints or restrict third-party use of this client id.
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_ENDPOINT = "https://claude.ai/oauth/authorize";
export const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(verifier: string): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("code", "true");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return url.toString();
}

/** Accepts "CODE" or the callback page's "CODE#STATE" paste format. */
export function parsePastedCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) || undefined };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/oauth.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/oauth.ts tests/oauth.test.ts
git commit -m "feat(agent): PKCE primitives and authorize URL for claude.ai OAuth"
```

---

### Task 2: Token exchange, refresh, credential store

**Files:**
- Modify: `src/agent/oauth.ts` (append)
- Test: extend `tests/oauth.test.ts`

**Interfaces:**
- Consumes: `OAuthTokens` from Task 1.
- Produces (used by Tasks 3–5):
  - `type FetchLike = typeof fetch`
  - `exchangeCode(code: string, verifier: string, fetchImpl?: FetchLike): Promise<OAuthTokens>`
  - `refreshTokens(refreshToken: string, fetchImpl?: FetchLike): Promise<OAuthTokens>`
  - `loadOwnCredentials(configBase?: string): OAuthTokens | undefined`
  - `saveCredentials(tokens: OAuthTokens, configBase?: string): void`
  - `clearCredentials(configBase?: string): void`
  - `loadBorrowedCredentials(home?: string): OAuthTokens | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `tests/oauth.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  exchangeCode, refreshTokens,
  loadOwnCredentials, saveCredentials, clearCredentials, loadBorrowedCredentials
} from "../src/agent/oauth.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("token exchange and refresh", () => {
  it("exchanges a code and maps the response fields", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "user:inference" });
    }) as never;
    const tokens = await exchangeCode("mycode", "myverifier", fetchImpl);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe(TOKEN_ENDPOINT);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("mycode");
    expect(body.code_verifier).toBe("myverifier");
    expect(body.client_id).toBe(OAUTH_CLIENT_ID);
  });

  it("throws without storing on HTTP failure", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as never;
    await expect(exchangeCode("bad", "verifier", fetchImpl)).rejects.toThrow("400");
  });

  it("refreshes via grant_type=refresh_token", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okResponse({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 });
    }) as never;
    const tokens = await refreshTokens("rt-old", fetchImpl);
    expect(tokens.accessToken).toBe("at2");
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("rt-old");
  });
});

describe("credential store", () => {
  it("round-trips own credentials atomically with restrictive permissions", () => {
    const base = mkdtempSync(join(tmpdir(), "oauth-store-"));
    saveCredentials({ accessToken: "a", expiresAt: 1 }, base);
    expect(loadOwnCredentials(base)?.accessToken).toBe("a");
    if (process.platform !== "win32") {
      expect(readFileSync(join(base, "credentials.json")).mode & 0o777).toBe(0o600);
    }
    clearCredentials(base);
    expect(loadOwnCredentials(base)).toBeUndefined();
    rmSync(base, { recursive: true, force: true });
  });

  it("treats malformed files as not logged in", () => {
    const base = mkdtempSync(join(tmpdir(), "oauth-bad-"));
    writeFileSync(join(base, "credentials.json"), "{broken");
    expect(loadOwnCredentials(base)).toBeUndefined();
    rmSync(base, { recursive: true, force: true });
  });

  it("borrows Claude Code credentials read-only", () => {
    const home = mkdtempSync(join(tmpdir(), "fake-home-"));
    writeFileSync(join(home, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "borrowed", expiresAt: Date.now() + 99999 }
    }));
    expect(loadBorrowedCredentials(home)?.accessToken).toBe("borrowed");
    // Nothing written back into ~/.claude.
    expect(loadOwnCredentials(join(home, ".cloudcode"))).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });
});
```

Note: `saveCredentials`/`loadOwnCredentials` take an explicit `configBase`
directory (the store lives at `<configBase>/credentials.json`) so tests never
touch the real home directory. Borrowing reads `<home>/.claude/.credentials.json`.

Run: `npx vitest run tests/oauth.test.ts`
Expected: FAIL — functions missing.

- [ ] **Step 2: Implement**

Append to `src/agent/oauth.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

type FetchLike = typeof fetch;

async function postToken(body: Record<string, unknown>, fetchImpl: FetchLike): Promise<OAuthTokens> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "cloudcode" },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`OAuth token request failed (HTTP ${res.status}).`);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : undefined
  };
}

export async function exchangeCode(code: string, verifier: string, fetchImpl: FetchLike = fetch): Promise<OAuthTokens> {
  return postToken({
    grant_type: "authorization_code", code,
    state: code, client_id: OAUTH_CLIENT_ID, redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  }, fetchImpl);
}

export async function refreshTokens(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<OAuthTokens> {
  return postToken({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID
  }, fetchImpl);
}

export const EXPIRY_SKEW_MS = 60_000;

export function isExpired(tokens: OAuthTokens, now = Date.now()): boolean {
  return now + EXPIRY_SKEW_MS >= tokens.expiresAt;
}

function ownPath(configBase?: string): string {
  return join(configBase ?? configDir(), "credentials.json");
}

export function loadOwnCredentials(configBase?: string): OAuthTokens | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownPath(configBase), "utf8")) as { claudeAiOauth?: OAuthTokens };
    const t = parsed.claudeAiOauth;
    return t && typeof t.accessToken === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

export function saveCredentials(tokens: OAuthTokens, configBase?: string): void {
  const path = ownPath(configBase);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ claudeAiOauth: tokens }, null, 2));
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function clearCredentials(configBase?: string): void {
  try { unlinkSync(ownPath(configBase)); } catch { /* already absent */ }
}

/** Read-only borrow of an existing Claude Code login. Never refreshed and
 * never written back; expired borrows simply report not-logged-in. */
export function loadBorrowedCredentials(home: string = homedir()): OAuthTokens | undefined {
  const path = join(home, ".claude", ".credentials.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { claudeAiOauth?: OAuthTokens };
    const t = parsed.claudeAiOauth;
    return t && typeof t.accessToken === "string" && !isExpired(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
```

Also update the first import line of the file to include the node builtins
shown above (merge with the existing `node:crypto` import).

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/oauth.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/oauth.ts tests/oauth.test.ts
git commit -m "feat(agent): OAuth exchange, refresh, and tolerant credential store"
```

---

### Task 3: Network capability "oauth"

**Files:**
- Modify: `src/agent/networkPolicy.ts:6-13` (capability union)
- Test: extend `tests/networkPolicy.test.ts`

**Interfaces:**
- Produces: `"oauth"` joins `NetworkCapability`; `decideNetwork` denies it under both persisted modes (existing generic branch handles this — only the union changes).

- [ ] **Step 1: Write the failing test**

Add to `tests/networkPolicy.test.ts`:

```ts
it("denies oauth egress under providerOnly but allows it unrestricted", () => {
  expect(decideNetwork("providerOnly", { capability: "oauth", destination: TOKEN_ENDPOINT }).allowed).toBe(false);
  expect(decideNetwork("unrestricted", { capability: "oauth", destination: TOKEN_ENDPOINT }).allowed).toBe(true);
});
```

(import `TOKEN_ENDPOINT` from `../src/agent/oauth.js`.)

Run: `npx vitest run tests/networkPolicy.test.ts`
Expected: FAIL — `"oauth"` is not assignable to `NetworkCapability`.

- [ ] **Step 2: Implement**

In `src/agent/networkPolicy.ts`, add to the `NetworkCapability` union:

```ts
  | "oauth"
```

No other change: the existing `request.capability !== "provider"` branch
already denies every non-provider capability under both persisted modes.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/networkPolicy.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/networkPolicy.ts tests/networkPolicy.test.ts
git commit -m "feat(agent): classify OAuth token egress as its own network capability"
```

---

### Task 4: Engine auth chain

**Files:**
- Modify: `src/engine/api.ts`
- Modify: `src/agent/session.ts` (options + three `makeClient(...)` call sites)
- Test: create `tests/engine-api-auth.test.ts`

**Interfaces:**
- Consumes: `OAuthTokens` from Task 1.
- Produces: `makeClient(cfg, auth?: { authToken: string; betaHeader?: string })`;
  `AgentSessionOptions.oauthAuthToken?: string` threaded to every internal
  `makeClient` call.

- [ ] **Step 1: Write the failing tests**

Create `tests/engine-api-auth.test.ts` following how existing engine tests
observe SDK behavior (if none inspect the constructor directly, assert on the
config object passed through by mocking `@anthropic-ai/sdk` like
`tests/app.test.ts` mocks `makeClient`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  const constructed: Array<Record<string, unknown>> = [];
  class FakeAnthropic {
    constructor(opts: Record<string, unknown>) { constructed.push(opts); }
    messages = { create: vi.fn() };
  }
  return { default: Object.assign(FakeAnthropic, { __constructed: constructed }) };
});

import Anthropic from "@anthropic-ai/sdk";
import { makeClient } from "../src/engine/api.js";

const constructed = (Anthropic as unknown as { __constructed: Array<Record<string, unknown>> }).__constructed;

beforeEach(() => { constructed.length = 0; });

describe("makeClient auth chain", () => {
  it("uses apiKey as before when present", () => {
    makeClient({ kind: "anthropic", apiKey: "sk-key" });
    expect(constructed[0]).toMatchObject({ apiKey: "sk-key" });
    expect(constructed[0].authToken).toBeUndefined();
  });

  it("uses Bearer authToken plus the OAuth beta header when given", () => {
    makeClient({}, { authToken: "oauth-token", betaHeader: "oauth-2025-04-20" });
    expect(constructed[0]).toMatchObject({
      apiKey: "none",
      authToken: "oauth-token",
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }
    });
  });
});
```

Adapt the mock/assertions to what the installed SDK version exposes; the
contract under test is exactly: explicit key wins, otherwise `authToken`
(Bearer) plus the beta header are set and `apiKey` falls back to `"none"`.

Run: `npx vitest run tests/engine-api-auth.test.ts`
Expected: FAIL — `makeClient` takes no auth parameter yet.

- [ ] **Step 2: Implement**

In `src/engine/api.ts`:

```ts
export interface ClientAuth {
  authToken: string;
  betaHeader?: string;
}

export function makeClient(cfg: ProviderConfig, auth?: ClientAuth): MessagesClient {
  if (cfg.kind === "openai") return makeOpenAIClient(cfg);
  const anthropic = new Anthropic({
    apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "none",
    baseURL: cfg.baseUrl,
    ...(auth ? {
      authToken: auth.authToken,
      defaultHeaders: auth.betaHeader ? { "anthropic-beta": auth.betaHeader } : undefined
    } : {})
  });
  return { /* unchanged */ };
}
```

Keep the returned wrapper exactly as-is. Then in `src/agent/session.ts`:

1. Add `oauthAuthToken?: string;` to `AgentSessionOptions`.
2. Build one auth value next to the tool registry setup:

```ts
const clientAuth = this.opts.oauthAuthToken
  ? { authToken: this.opts.oauthAuthToken, betaHeader: "oauth-2025-04-20" }
  : undefined;
```

3. Thread it through every internal `makeClient(this.opts.provider)` call
   (loop construction, the task-tool `client:` accessor, memory extraction):
   `makeClient(this.opts.provider, clientAuth)`.

Export the literal from `engine/api.ts` instead of repeating it if cleaner:

```ts
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
```

and use `{ authToken: ..., betaHeader: OAUTH_BETA_HEADER }`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/engine-api-auth.test.ts tests/session.test.ts tests/session-integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/engine/api.ts src/agent/session.ts tests/engine-api-auth.test.ts
git commit -m "feat(engine): OAuth bearer authentication in the anthropic client chain"
```

---

### Task 5: `cloudcode login | logout | status`

**Files:**
- Create: `src/commands/cli/login.ts`
- Modify: `src/cliArgs.ts` (`SUBCOMMANDS`, usage text)
- Modify: `src/cli.tsx` (subcommand dispatch)
- Modify: `src/ui/nativeApp.ts` or `src/cli.tsx` interactive start — resolve OAuth before session creation
- Test: `tests/cliLogin.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `runLoginCommand(args: string[], deps: LoginDeps): Promise<{ exitCode: number; stdout?: string; stderr?: string }>`
  with `LoginDeps = { configBase?: string; home?: string; fetchImpl?: FetchLike; promptText?(label: string): Promise<string>; openBrowser?(url: string): void; networkMode: NetworkMode }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cliLogin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoginCommand } from "../src/commands/cli/login.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function makeDeps(overrides: Partial<Parameters<typeof runLoginCommand>[1]> = {}) {
  const configBase = mkdtempSync(join(tmpdir(), "login-cmd-"));
  return {
    configBase,
    prompts: [] as string[],
    deps: {
      configBase,
      networkMode: "unrestricted" as const,
      promptText: overrides.promptText ?? (async () => "paste-code"),
      openBrowser: overrides.openBrowser ?? (() => {}),
      fetchImpl: overrides.fetchImpl ?? (async () => okResponse({
        access_token: "at", refresh_token: "rt", expires_in: 3600
      })) as never
    }
  };
}

describe("runLoginCommand", () => {
  it("prints the authorize URL, exchanges the pasted code, and saves", async () => {
    const { deps, configBase } = makeDeps();
    const result = await runLoginCommand(["login"], deps.deps);
    expect(result.exitCode).toBe(0);
    expect(deps.deps.promptText).toBeDefined();
    expect(existsSync(join(configBase, "credentials.json"))).toBe(true);
  });

  it("refuses under providerOnly with widening guidance", async () => {
    const { deps } = makeDeps();
    const result = await runLoginCommand(["login"], { ...deps.deps, networkMode: "providerOnly" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--network-mode unrestricted");
    expect(result.stdout ?? "").not.toContain("https://claude.ai/oauth/authorize");
  });

  it("status reports logged-in expiry", async () => {
    const { deps } = makeDeps();
    await runLoginCommand(["login"], deps.deps);
    const result = await runLoginCommand(["status"], deps.deps);
    expect(result.stdout).toContain("logged in");
  });

  it("logout removes stored credentials", async () => {
    const { deps, configBase } = makeDeps();
    await runLoginCommand(["login"], deps.deps);
    await runLoginCommand(["logout"], deps.deps);
    expect(existsSync(join(configBase, "credentials.json"))).toBe(false);
    const status = await runLoginCommand(["status"], deps.deps);
    expect(status.stdout).toContain("not logged in");
  });
});
```

Run: `npx vitest run tests/cliLogin.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

Create `src/commands/cli/login.ts`:

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EXIT_CODES } from "../../print/exitCodes.js";
import { decideNetwork } from "../../agent/networkPolicy.js";
import {
  buildAuthorizeUrl, exchangeCode, generateVerifier, parsePastedCode,
  loadOwnCredentials, saveCredentials, clearCredentials,
  loadBorrowedCredentials, TOKEN_ENDPOINT
} from "../../agent/oauth.js";

export interface LoginDeps {
  configBase?: string;
  home?: string;
  networkMode: "offlineStrict" | "providerOnly" | "unrestricted";
  fetchImpl?: typeof fetch;
  promptText?(label: string): Promise<string>;
  openBrowser?(url: string): void;
}

function defaultPrompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(label, answer => { rl.close(); resolve(answer); }));
}

function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* manual copy */ }
}

export async function runLoginCommand(
  args: string[],
  deps: LoginDeps
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const verb = args[0] ?? "status";
  if (verb === "logout") {
    clearCredentials(deps.configBase);
    return { exitCode: 0, stdout: "Logged out (cloudcode credentials removed)." };
  }
  if (verb === "status") {
    const own = loadOwnCredentials(deps.configBase);
    if (own) {
      return { exitCode: 0, stdout: `Logged in via claude.ai OAuth (access token expires ${new Date(own.expiresAt).toLocaleString()}).` };
    }
    if (loadBorrowedCredentials(deps.home)) {
      return { exitCode: 0, stdout: "Using an existing Claude Code login (~/.claude). Run `cloudcode login` to manage your own credentials." };
    }
    return { exitCode: 0, stdout: "Not logged in. Set ANTHROPIC_API_KEY or run `cloudcode login`." };
  }
  if (verb !== "login") {
    return { exitCode: EXIT_CODES.invalidConfiguration, stderr: `Unknown login verb "${verb}". Use login | logout | status.` };
  }

  // Exchange hits console.anthropic.com: cloudcode-owned egress, denied
  // outside unrestricted by the privacy contract.
  const decision = decideNetwork(deps.networkMode, { capability: "oauth", destination: TOKEN_ENDPOINT });
  if (!decision.allowed) {
    return {
      exitCode: EXIT_CODES.invalidConfiguration,
      stderr: "Login requires network access. Re-run: --network-mode unrestricted cloudcode login"
    };
  }

  const verifier = generateVerifier();
  const url = buildAuthorizeUrl(verifier);
  console.log([
    "Open this URL in a browser and approve access:",
    "",
    `  ${url}`,
    "",
    "Then paste the code shown after approval (with or without the #state suffix):"
  ].join("\n"));
  deps.openBrowser?.(url);
  const prompt = deps.promptText ?? defaultPrompt;
  const pasted = await prompt("> ");
  // state === verifier by construction; PKCE binds the exchange to the
  // verifier, so any pasted #state suffix is ignored here.
  const { code } = parsePastedCode(pasted);
  try {
    const tokens = await exchangeCode(code, verifier, deps.fetchImpl);
    saveCredentials(tokens, deps.configBase);
    return { exitCode: 0, stdout: `\nLogged in. Access token expires ${new Date(tokens.expiresAt).toLocaleString()}.` };
  } catch (err) {
    return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
  }
}
```

Check `EXIT_CODES` in `src/print/exitCodes.ts`: the roadmap reserves exit 7
for privacy/network-policy denial — if the constant exists use it for the
denied branch; otherwise keep `invalidConfiguration`.

Wire `"login"` into `SUBCOMMANDS` in `src/cliArgs.ts` (plus the usage-text
list) and dispatch in `src/cli.tsx`'s subcommand `switch`, matching how
neighboring cases read settings and pass through `--network-mode`:

```ts
case "login": {
  const result = await runLoginCommand(parsed.args, {
    configBase: undefined, home: undefined,
    networkMode: /* the invocation's effective mode, from parsed/settings */,
    fetchImpl: fetch
  });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
  break;
}
```

Interactive/print start-up OAuth resolution: in `src/cli.tsx`, before session
creation, when the selected anthropic-kind provider has no `apiKey` and no
`ANTHROPIC_API_KEY` env var:

```ts
const oauth = loadOwnCredentials() ?? loadBorrowedCredentials();
let oauthAuthToken: string | undefined;
if (oauth && !isExpired(oauth)) oauthAuthToken = oauth.accessToken;
else if (oauth?.refreshToken && effectiveMode === "unrestricted") {
  try { oauthAuthToken = (await refreshTokens(oauth.refreshToken)).accessToken; }
  catch { console.error("OAuth token refresh failed; continuing unauthenticated."); }
} else if (oauth && isExpired(oauth)) {
  console.error("OAuth token expired; refresh requires --network-mode unrestricted.");
}
```

Thread `oauthAuthToken` into `new AgentSession({...})` and print-mode options.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/cliLogin.test.ts tests/cliArgs.test.ts tests/session.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/cli/login.ts src/cliArgs.ts src/cli.tsx tests/cliLogin.test.ts
git commit -m "feat(cli): cloudcode login/logout/status with manual-paste PKCE flow"
```

---

### Task 6: Doctor auth line + README rewrite

**Files:**
- Modify: `src/commands/cli/doctor.ts` (add one check entry)
- Modify: `README.md:14-16` (the "Reusing an existing Claude Code CLI login is not supported" sentence)

**Steps:**

- [ ] Add a doctor check after the provider-key checks:

```ts
{
  name: "authentication",
  ok: true,
  detail: (() => {
    const own = loadOwnCredentials(dir);
    if (own) return `claude.ai OAuth (expires ${new Date(own.expiresAt).toLocaleString()})`;
    if (env.ANTHROPIC_API_KEY || Object.values(providers).some(p => p.apiKey)) return "api key";
    if (loadBorrowedCredentials()) return "borrowed Claude Code login (~/.claude)";
    return "none configured";
  })()
}
```

(import `loadOwnCredentials, loadBorrowedCredentials` from
`../../agent/oauth.js`.)

- [ ] Rewrite the README sentence to:

```markdown
Auth: set `ANTHROPIC_API_KEY`, run `cloudcode login` to sign in with a
Claude.ai subscription (PKCE browser flow), or keep using an existing Claude
Code CLI login — cloudcode picks up `~/.claude/.credentials.json` read-only
when no other credential is configured.
```

- [ ] Extend `tests/cliDoctor.test.ts` with one assertion that the
  `authentication` check appears, then run the focused tests:

```powershell
npx vitest run tests/cliDoctor.test.ts tests/oauth.test.ts
```

Expected: PASS.

- [ ] Commit:

```bash
git add src/commands/cli/doctor.ts README.md tests/cliDoctor.test.ts
git commit -m "feat(cli): surface auth source in doctor; document OAuth login"
```

---

### Task 7: Full gates

- [ ] Run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```

Expected: all clean (pre-existing warnings in `tests/lsp/autoInject.test.ts`
are out of scope).

- [ ] Manual smoke (needs a human with a subscription):

```powershell
--network-mode unrestricted cloudcode login   # complete the browser flow
cloudcode status / doctor                     # verify auth source
cloudcode -p "say hi"                         # verify a turn works on Bearer auth
```
