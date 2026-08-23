import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateVerifier, challengeFor, buildAuthorizeUrl, parsePastedCode,
  OAUTH_CLIENT_ID, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT,
  exchangeCode, refreshTokens,
  loadOwnCredentials, saveCredentials, clearCredentials, loadBorrowedCredentials
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
  it("round-trips own credentials with restrictive permissions on POSIX", () => {
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
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "borrowed", expiresAt: Date.now() + 99999 }
    }));
    expect(loadBorrowedCredentials(home)?.accessToken).toBe("borrowed");
    expect(loadOwnCredentials(join(home, ".cloudcode"))).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });
});
