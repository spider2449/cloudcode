import { describe, it, expect, vi, afterEach } from "vitest";
import { makeOpenAIClient } from "../src/engine/openaiApi.js";
import type { StreamRequest } from "../src/engine/api.js";

function sseStream(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    }
  });
}

function mockFetch(chunks: object[], status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    body: sseStream(chunks),
    text: async () => ""
  }));
}

async function collect(client: { create(req: StreamRequest, signal: AbortSignal): AsyncIterable<Record<string, unknown>> }, req: StreamRequest) {
  const events: Record<string, unknown>[] = [];
  for await (const e of client.create(req, new AbortController().signal)) events.push(e);
  return events;
}

const baseReq: StreamRequest = {
  model: "z-ai/glm-5.2",
  system: "sys prompt",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  max_tokens: 100
};

describe("makeOpenAIClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates a text-only stream into Anthropic-shaped events", async () => {
    const fetchMock = mockFetch([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    const events = await collect(client, baseReq);

    expect(events).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 3 } }
    ]);
  });

  it("translates streamed tool_calls into tool_use blocks", async () => {
    const fetchMock = mockFetch([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "EchoTool", arguments: "" } }] } } ] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"x\":1}" } }] } } ] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    const events = await collect(client, baseReq);

    expect(events).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "EchoTool" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 5, output_tokens: 2 } }
    ]);
  });

  it("maps finish_reason length to max_tokens", async () => {
    const fetchMock = mockFetch([
      { choices: [{ delta: { content: "cut off" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] }
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    const events = await collect(client, baseReq);
    const last = events[events.length - 1];
    expect(last).toEqual({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: undefined });
  });

  it("builds the request body with system, tools and cache_control stripped", async () => {
    const fetchMock = mockFetch([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "secret" });
    await collect(client, {
      model: "m",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "EchoTool", input: { x: 1 } }]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] }
      ],
      tools: [{ name: "EchoTool", description: "echoes", input_schema: { type: "object" } }],
      max_tokens: 50
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "tu_1", type: "function", function: { name: "EchoTool", arguments: "{\"x\":1}" } }] },
      { role: "tool", tool_call_id: "tu_1", content: "ok" }
    ]);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "EchoTool", description: "echoes", parameters: { type: "object" } } }
    ]);
    expect(body.max_tokens).toBe(50);
  });

  it("omits the tools key when there are no tools", async () => {
    const fetchMock = mockFetch([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    await collect(client, baseReq);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, body: null, text: async () => "not found" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeOpenAIClient({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    await expect(collect(client, baseReq)).rejects.toThrow(/404/);
  });
});
