import { describe, it, expect, vi } from "vitest";
import { fetchModels } from "../src/agent/models.js";

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe("fetchModels", () => {
  it("queries {baseUrl}/v1/models with a bearer token when apiKey is set", async () => {
    const fetchFn = ok({ data: [{ id: "llama-3" }, { id: "qwen-2.5" }] });
    const models = await fetchModels({ baseUrl: "http://localhost:8080", apiKey: "sk-x" }, fetchFn as never);
    expect(models).toEqual(["llama-3", "qwen-2.5"]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:8080/v1/models");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-x" });
  });

  it("omits the Authorization header when apiKey is unset", async () => {
    const fetchFn = ok({ data: [] });
    await fetchModels({ baseUrl: "http://localhost:8080" }, fetchFn as never);
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchFn = ok({ data: [] });
    await fetchModels({ baseUrl: "http://localhost:8080/" }, fetchFn as never);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/v1/models");
  });

  it("does not double /v1 when baseUrl already ends with /v1", async () => {
    const fetchFn = ok({ data: [{ id: "z-ai/glm-5.2" }] });
    const models = await fetchModels({ baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "nvapi-x" }, fetchFn as never);
    expect(models).toEqual(["z-ai/glm-5.2"]);
    expect(fetchFn.mock.calls[0][0]).toBe("https://integrate.api.nvidia.com/v1/models");
  });

  it("queries the Anthropic API with x-api-key when no baseUrl", async () => {
    const fetchFn = ok({ data: [{ id: "claude-sonnet-5" }] });
    const models = await fetchModels({ apiKey: "sk-ant" }, fetchFn as never);
    expect(models).toEqual(["claude-sonnet-5"]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
  });

  it("falls back to ANTHROPIC_API_KEY env for the anthropic provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const fetchFn = ok({ data: [] });
    await fetchModels({}, fetchFn as never);
    expect(fetchFn.mock.calls[0][1].headers).toMatchObject({ "x-api-key": "sk-env" });
    vi.unstubAllEnvs();
  });

  it("resolves [] without a request when anthropic has no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const fetchFn = ok({ data: [] });
    expect(await fetchModels({}, fetchFn as never)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("resolves [] on non-OK status", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchModels({ baseUrl: "http://x" }, fetchFn as never)).toEqual([]);
  });

  it("resolves [] on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await fetchModels({ baseUrl: "http://x" }, fetchFn as never)).toEqual([]);
  });

  it("resolves [] on malformed body and skips entries without string ids", async () => {
    const bad = ok({ nope: true });
    expect(await fetchModels({ baseUrl: "http://x" }, bad as never)).toEqual([]);
    const mixed = ok({ data: [{ id: "good" }, { id: 42 }, "junk"] });
    expect(await fetchModels({ baseUrl: "http://x" }, mixed as never)).toEqual(["good"]);
  });
});
