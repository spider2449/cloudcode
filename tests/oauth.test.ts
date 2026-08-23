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
