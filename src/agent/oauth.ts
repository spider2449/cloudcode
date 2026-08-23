import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

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
