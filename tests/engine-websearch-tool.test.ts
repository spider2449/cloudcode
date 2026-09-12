import { describe, it, expect, vi, afterEach } from "vitest";
import { websearchTool, parseDuckDuckGoHtml } from "../src/engine/tools/websearch.js";
import type { ToolContext } from "../src/engine/tools/types.js";

const baseCtx: ToolContext = { cwd: process.cwd() };

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

const SAMPLE = `
<table>
<tr><td><a class="result__a" href="https://example.com/a">Example <b>A</b></a></td>
<td class="result__snippet">First <b>snippet</b> here</td></tr>
<tr><td><a class="result__a" href="https://example.com/b">Example B</a></td>
<td class="result__snippet">Second snippet</td></tr>
</table>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDuckDuckGoHtml", () => {
  it("extracts titles, urls, and snippets", () => {
    const out = parseDuckDuckGoHtml(SAMPLE, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: "Example A", url: "https://example.com/a", snippet: "First snippet here" });
    expect(out[1].url).toBe("https://example.com/b");
  });

  it("respects the max count", () => {
    expect(parseDuckDuckGoHtml(SAMPLE, 1)).toHaveLength(1);
  });

  it("skips non-http hrefs", () => {
    const html = `<a class="result__a" href="/relative">Nope</a>`;
    expect(parseDuckDuckGoHtml(html, 5)).toHaveLength(0);
  });
});

describe("WebSearch tool", () => {
  it("rejects empty queries without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await websearchTool.execute({ query: "  " }, baseCtx);
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consults the network guard before fetching", async () => {
    const require = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(SAMPLE)));
    const out = await websearchTool.execute(
      { query: "hello" },
      { ...baseCtx, networkPolicy: { require } }
    );
    expect(require).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "webSearch" })
    );
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("https://example.com/a");
  });

  it("propagates a network-policy denial as a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      websearchTool.execute({ query: "hello" }, {
        ...baseCtx,
        networkPolicy: { require: () => { throw new Error("Network policy denied"); } }
      })
    ).rejects.toThrow("Network policy");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports no results cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("<html></html>")));
    const out = await websearchTool.execute({ query: "zzznoresult" }, baseCtx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("no results");
  });

  it("maps http errors to error results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", { status: 429 })));
    const out = await websearchTool.execute({ query: "hi" }, baseCtx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("429");
  });

  it("reports timeouts as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError")));
    const out = await websearchTool.execute({ query: "slow" }, baseCtx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("timed out");
  });
});
