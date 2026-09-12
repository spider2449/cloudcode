import type { ToolDef } from "./types.js";

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_HOST = "html.duckduckgo.com";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 10_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code: string) => {
      try {
        return String.fromCharCode(Number(code));
      } catch {
        return _;
      }
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Parse DuckDuckGo HTML results. Exported for testing. */
export function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Anchors with class result__a carry the title + target url.
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null && results.length < max) {
    const rawUrl = decodeEntities(match[1]);
    const title = stripTags(match[2]);
    if (!title || !rawUrl.startsWith("http")) continue;
    // The snippet follows the anchor in a result__snippet cell.
    const rest = html.slice(match.index, match.index + 8000);
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(rest);
    results.push({
      title,
      url: rawUrl,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : ""
    });
  }
  return results;
}

export const SEARCH_RESULT_HOST = SEARCH_HOST;

export const websearchTool: ToolDef = {
  name: "WebSearch",
  description: "Search the web and return titles, URLs, and snippets. Fetch full content with WebFetch.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Max results (default 5, max 10)" }
    },
    required: ["query"]
  },
  async execute(input, ctx) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return { content: "Search query is empty", isError: true };
    const requested = typeof input.count === "number" ? Math.floor(input.count) : DEFAULT_COUNT;
    const count = Math.min(Math.max(requested || DEFAULT_COUNT, 1), MAX_COUNT);

    ctx.networkPolicy?.require({ capability: "webSearch", destination: SEARCH_ENDPOINT });

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const body = new URLSearchParams({ q: query });
    let res: Response;
    try {
      res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "follow",
        signal
      });
    } catch (err) {
      if (ctx.signal?.aborted) return { content: "Interrupted by user", isError: true };
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: name === "TimeoutError" || message.includes("aborted")
          ? `Search timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : `Search failed: ${message}`,
        isError: true
      };
    }
    if (res.status >= 400) return { content: `Search failed: ${res.status} for ${SEARCH_HOST}`, isError: true };
    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    const results = parseDuckDuckGoHtml(html, count);
    if (results.length === 0) return { content: `(no results for "${query}")` };
    let text = results
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
    }
    return { content: text };
  }
};
