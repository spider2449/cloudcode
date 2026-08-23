import { describe, it, expect, vi } from "vitest";
import { applyContextWindow, detectContextWindow } from "../src/agent/contextProbe.js";

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe("detectContextWindow", () => {
  it("parses default_generation_settings.n_ctx (current llama.cpp builds)", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 }, total_slots: 4 });
    expect(await detectContextWindow({ baseUrl: "http://localhost:8080" }, fetchFn as never)).toBe(262144);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/props");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 4096 } });
    await detectContextWindow({ baseUrl: "http://localhost:8080/" }, fetchFn as never);
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:8080/props");
  });

  it("falls back to top-level n_ctx (older builds)", async () => {
    const fetchFn = ok({ n_ctx: 32768 });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBe(32768);
  });

  it("prefers nested over top-level when both exist", async () => {
    const fetchFn = ok({ n_ctx: 1, default_generation_settings: { n_ctx: 8192 } });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBe(8192);
  });

  it("rejects zero, negative, fractional, and non-number values", async () => {
    for (const bad of [0, -1, 1.5, "32768", null]) {
      const fetchFn = ok({ default_generation_settings: { n_ctx: bad } });
      expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
    }
  });

  it("resolves undefined without a request when there is no baseUrl", async () => {
    const fetchFn = ok({});
    expect(await detectContextWindow({}, fetchFn as never)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resolves undefined on non-OK status", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });

  it("resolves undefined on malformed JSON body", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("bad json"); } });
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });

  it("resolves undefined on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await detectContextWindow({ baseUrl: "http://x" }, fetchFn as never)).toBeUndefined();
  });
});

describe("applyContextWindow", () => {
  it("assigns the detected value to the in-memory provider", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 } });
    const provider = { kind: "openai" as const, baseUrl: "http://localhost:8080" };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBe(262144);
  });

  it("keeps a manually configured model_context_window without probing", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 262144 } });
    const provider = { kind: "openai" as const, baseUrl: "http://x", model_context_window: 4096 };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBe(4096);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips anthropic-kind providers entirely", async () => {
    const fetchFn = ok({ n_ctx: 1000 });
    const provider = { kind: "anthropic" as const };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("tolerates an undefined provider", async () => {
    const fetchFn = ok({});
    await expect(applyContextWindow(undefined, fetchFn as never)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves model_context_window unset when detection fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const provider = { kind: "openai" as const, baseUrl: "http://x" };
    await applyContextWindow(provider, fetchFn as never);
    expect(provider.model_context_window).toBeUndefined();
  });

  it("memoizes by trimmed baseUrl within the process, including failures", async () => {
    const fetchFn = ok({ default_generation_settings: { n_ctx: 8192 } });
    const hit = { kind: "openai" as const, baseUrl: "http://m" };
    const again = { kind: "openai" as const, baseUrl: "http://m/" };
    await applyContextWindow(hit, fetchFn as never);
    await applyContextWindow(again, fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(hit.model_context_window).toBe(8192);
    expect(again.model_context_window).toBe(8192);

    const failedFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const miss = { kind: "openai" as const, baseUrl: "http://m2" };
    await applyContextWindow(miss, failedFetch as never);
    await applyContextWindow(miss, failedFetch as never);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });
});
