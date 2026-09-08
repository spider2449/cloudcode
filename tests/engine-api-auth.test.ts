import { describe, it, expect, vi, beforeEach } from "vitest";

const constructed: Array<Record<string, unknown>> = [];
const instances: Array<{ messages: { create: ReturnType<typeof vi.fn> }; beta: { messages: { create: ReturnType<typeof vi.fn> } } }> = [];
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    opts: Record<string, unknown>;
    messages = { create: vi.fn(async function* () {}) };
    beta = { messages: { create: vi.fn(async function* () {}) } };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      constructed.push(opts);
      instances.push(this);
    }
  }
  return { default: FakeAnthropic };
});

import { makeClient, OAUTH_BETA_HEADER, CONTEXT_MANAGEMENT_BETA } from "../src/engine/api.js";

beforeEach(() => { constructed.length = 0; instances.length = 0; });

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

  it("routes requests without betas through messages.create", async () => {
    const client = makeClient({ kind: "anthropic", apiKey: "sk-key" });
    const signal = new AbortController().signal;
    for await (const _ of client.create({ model: "m", system: "s", messages: [], tools: [], max_tokens: 8 }, signal)) { /* drain */ }
    const inst = instances[instances.length - 1];
    expect(inst.messages.create).toHaveBeenCalledOnce();
    expect(inst.beta.messages.create).not.toHaveBeenCalled();
  });

  it("routes requests with betas through beta.messages.create preserving betas", async () => {
    const client = makeClient({ kind: "anthropic", apiKey: "sk-key" });
    const signal = new AbortController().signal;
    const req = {
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      max_tokens: 8,
      betas: [CONTEXT_MANAGEMENT_BETA],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    };
    for await (const _ of client.create(req, signal)) { /* drain */ }
    const inst = instances[instances.length - 1];
    expect(inst.beta.messages.create).toHaveBeenCalledOnce();
    expect(inst.messages.create).not.toHaveBeenCalled();
    const body = (inst.beta.messages.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body.betas).toEqual([CONTEXT_MANAGEMENT_BETA]);
    expect(body.context_management).toBeDefined();
  });
});
