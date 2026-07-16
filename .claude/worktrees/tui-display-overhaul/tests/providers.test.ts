import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviders, providerEnv } from "../src/agent/providers.js";

describe("loadProviders", () => {
  it("returns anthropic default when file is missing", () => {
    const p = loadProviders(join(tmpdir(), "nope", "providers.json"));
    expect(p.anthropic).toEqual({});
  });

  it("merges file providers with default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({
      local: { baseUrl: "http://127.0.0.1:8080", apiKey: "none", model: "qwen2.5-coder-32b" }
    }));
    const p = loadProviders(file);
    expect(p.anthropic).toEqual({});
    expect(p.local.model).toBe("qwen2.5-coder-32b");
  });

  it("returns default on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, "{bad");
    expect(loadProviders(file)).toEqual({ anthropic: {} });
  });
});

describe("providerEnv", () => {
  it("maps baseUrl and apiKey to ANTHROPIC_* vars", () => {
    expect(providerEnv({ baseUrl: "http://x", apiKey: "k" })).toEqual({
      ANTHROPIC_BASE_URL: "http://x",
      ANTHROPIC_API_KEY: "k"
    });
  });

  it("returns empty object for empty config", () => {
    expect(providerEnv({})).toEqual({});
  });
});
