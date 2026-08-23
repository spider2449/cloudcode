import { describe, it, expect, vi, beforeEach } from "vitest";

const constructed: Array<Record<string, unknown>> = [];
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      constructed.push(opts);
    }
    messages = { create: vi.fn() };
  }
  return { default: FakeAnthropic };
});

import { makeClient, OAUTH_BETA_HEADER } from "../src/engine/api.js";

beforeEach(() => { constructed.length = 0; });

function lastOpts(): Record<string, unknown> {
  return constructed[constructed.length - 1];
}

describe("makeClient auth chain", () => {
  it("uses apiKey as before when present", () => {
    makeClient({ kind: "anthropic", apiKey: "sk-key" });
    expect(lastOpts()).toMatchObject({ apiKey: "sk-key" });
    expect(lastOpts().authToken).toBeUndefined();
  });

  it("falls back to env and 'none' without auth", () => {
    delete process.env.ANTHROPIC_API_KEY;
    makeClient({ kind: "anthropic" });
    expect(lastOpts()).toMatchObject({ apiKey: "none" });
  });

  it("uses Bearer authToken plus the OAuth beta header when given", () => {
    makeClient({}, { authToken: "oauth-token", betaHeader: OAUTH_BETA_HEADER });
    expect(lastOpts()).toMatchObject({
      authToken: "oauth-token",
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }
    });
  });
});
