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
