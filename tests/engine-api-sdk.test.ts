import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_MANAGEMENT_BETA, makeClient, OAUTH_BETA_HEADER, type StreamRequest } from "../src/engine/api.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function fixture() {
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(body) as Record<string, unknown> });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

const request: StreamRequest = {
  model: "test-model", system: [{ type: "text", text: "test", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "test_tool", description: "Test tool", input_schema: { type: "object", properties: {} } }],
  max_tokens: 16, thinking: { type: "adaptive" }, output_config: { effort: "high" }
};

describe("actual Anthropic SDK compatibility", () => {
  it("serializes stable requests and yields SSE events with API key authentication", async () => {
    const { baseUrl, requests } = await fixture();
    const client = makeClient({ apiKey: "test-key", baseUrl });
    const events = [];
    for await (const event of client.create(request, new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_stop" }
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: "/v1/messages", headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" }, body: { ...request, stream: true } });
  });

  it("merges OAuth and context-management beta headers and preserves the beta payload", async () => {
    const { baseUrl, requests } = await fixture();
    const client = makeClient({ baseUrl }, { authToken: "test-oauth" });
    const betaRequest: StreamRequest = {
      ...request, betas: [CONTEXT_MANAGEMENT_BETA],
      context_management: { edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 1000 }, keep: { type: "tool_uses", value: 2 } }] }
    };
    for await (const _ of client.create(betaRequest, new AbortController().signal)) { /* Drain the stream. */ }
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe("Bearer test-oauth");
    expect(requests[0].headers["anthropic-beta"]?.toString().split(",")).toEqual(expect.arrayContaining([OAUTH_BETA_HEADER, CONTEXT_MANAGEMENT_BETA]));
    expect(requests[0].body).toMatchObject({ context_management: betaRequest.context_management, stream: true });
    expect(requests[0].body.betas).toBeUndefined();
  });

  it("rejects a cancelled request without sending it", async () => {
    const { baseUrl, requests } = await fixture();
    const client = makeClient({ apiKey: "test-key", baseUrl });
    const controller = new AbortController();
    controller.abort();
    const drain = async () => {
      for await (const _ of client.create(request, controller.signal)) { /* Drain the stream. */ }
    };
    await expect(drain()).rejects.toThrow(/abort/i);
    expect(requests).toHaveLength(0);
  });
});
