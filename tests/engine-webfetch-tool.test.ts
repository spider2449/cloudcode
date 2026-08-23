import { describe, it, expect, vi, afterEach } from "vitest";
import { webfetchTool } from "../src/engine/tools/webfetch.js";
import type { ToolContext } from "../src/engine/tools/types.js";

const baseCtx: ToolContext = { cwd: process.cwd() };

function okResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(url: string, ctx: ToolContext = baseCtx) {
  return webfetchTool.execute({ url }, ctx);
}

describe("WebFetch tool", () => {
  it("rejects non-http(s) schemes without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run("file:///etc/passwd");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unsupported protocol");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unparseable urls", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await run("not a url");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Invalid URL");
  });

  it("consults the network guard before fetching", async () => {
    const require = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("<p>hi</p>", "text/html")));
    const out = await run("https://example.com/x", { ...baseCtx, networkPolicy: { require } });
    expect(require).toHaveBeenCalledWith(expect.objectContaining({ capability: "webFetch", destination: "https://example.com/x" }));
    expect(out.isError).toBeUndefined();
  });

  it("propagates a network-policy denial as a thrown error (the loop's per-tool boundary converts it)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(run("https://example.com/x", {
      ...baseCtx,
      networkPolicy: { require: () => { throw new Error("Network policy providerOnly denied webFetch access to example.com (capabilityDenied)."); } }
    })).rejects.toThrow("Network policy");
    // The guard runs before any fetch happens.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("converts html responses to markdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("<h1>Docs</h1><p>Body text</p>", "text/html; charset=utf-8")));
    const out = await run("https://example.com/x");
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("# Docs");
    expect(out.content).toContain("Body text");
  });

  it("passes plain text through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("plain words", "text/plain")));
    const out = await run("https://example.com/x");
    expect(out.content).toBe("plain words");
  });

  it("pretty-prints json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse('{"a":1}', "application/json")));
    const out = await run("https://example.com/api");
    expect(out.content).toContain('"a": 1');
  });

  it("rejects binary content types", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("\u0089PNG", "image/png")));
    const out = await run("https://example.com/img.png");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unsupported content type");
  });

  it("maps http error statuses to friendly messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404, headers: { "content-type": "text/html" } })));
    const out = await run("https://example.com/missing");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("404");
    expect(out.content).toContain("not found");
  });

  it("truncates oversized output with a marker", async () => {
    const bigHtml = `<p>${"x".repeat(60_000)}</p>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(bigHtml, "text/html")));
    const out = await run("https://example.com/big");
    expect(out.content.length).toBeLessThan(60_000);
    expect(out.content).toContain("[truncated");
  });

  it("enforces the 5 MB body cap while streaming", async () => {
    // A stream that would exceed the cap: more than 5 MB total.
    const chunk = "y".repeat(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) { controller.close(); return; }
        sent += 1;
        controller.enqueue(new TextEncoder().encode(chunk));
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })));
    const out = await run("https://example.com/huge");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("5 MB");
  });

  it("reports fetch failures (dns, refused) as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const out = await run("https://nonexistent.invalid/");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Fetch failed");
  });

  it("reports timeouts as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "TimeoutError")));
    const out = await run("https://slow.example.com/");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("timed out");
  });
});
