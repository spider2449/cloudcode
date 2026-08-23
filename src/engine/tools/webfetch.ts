import type { ToolDef } from "./types.js";
import { htmlToMarkdown } from "./htmlToMarkdown.js";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 50_000;

const STATUS_LABELS: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  410: "gone",
  429: "rate limited",
  500: "server error",
  502: "bad gateway",
  503: "service unavailable"
};

function statusMessage(status: number): string | undefined {
  return status >= 400 ? `${status} ${STATUS_LABELS[status] ?? "request failed"}` : undefined;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response body");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${MAX_BODY_BYTES / (1024 * 1024)} MB limit`);
    }
    chunks.push(value);
  }
  return chunks.map(chunk => Buffer.from(chunk).toString("utf8")).join("");
}

export const webfetchTool: ToolDef = {
  name: "WebFetch",
  description: "Fetch a web page over HTTP(S) and return its content converted to Markdown.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch" }
    },
    required: ["url"]
  },
  async execute(input, ctx) {
    const raw = typeof input.url === "string" ? input.url.trim() : "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { content: `Invalid URL: ${raw || "(empty)"}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { content: `Unsupported protocol: ${url.protocol} — use http or https`, isError: true };
    }
    ctx.networkPolicy?.require({ capability: "webFetch", destination: url.toString() });

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", signal });
    } catch (err) {
      // An aborted signal also surfaces as an AbortError; check the user's
      // interrupt first so it is not misreported as a timeout.
      if (ctx.signal?.aborted) return { content: "Interrupted by user", isError: true };
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: name === "TimeoutError" || message.includes("aborted")
          ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${raw}`
          : `Fetch failed: ${message}`,
        isError: true
      };
    }

    // Redirects may land somewhere the policy was never asked about.
    if (res.url && res.url !== url.toString()) {
      ctx.networkPolicy?.require({ capability: "webFetch", destination: res.url });
    }
    const status = statusMessage(res.status);
    if (status) return { content: `Fetch failed: ${status} for ${res.url || raw}`, isError: true };

    const contentType = res.headers.get("content-type") ?? "text/plain";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    let text: string;
    try {
      const body = await readCapped(res);
      if (mime === "text/html" || mime === "application/xhtml+xml") {
        text = htmlToMarkdown(body);
      } else if (mime === "application/json" || mime.endsWith("+json")) {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } else if (mime.startsWith("text/")) {
        text = body;
      } else {
        return { content: `Unsupported content type: ${contentType}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
    }
    return { content: text || "(empty response)" };
  }
};
