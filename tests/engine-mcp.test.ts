import { describe, it, expect } from "vitest";
import { McpManager } from "../src/engine/mcpClient.js";

const fakeFactory = async () => ({
  listTools: async () => ({ tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }] }),
  callTool: async (req: { name: string }) => ({ content: [{ type: "text", text: `ran:${req.name}` }] }),
  close: async () => {}
});

describe("McpManager", () => {
  it("namespaces tools and reports connected status", async () => {
    const mgr = new McpManager(fakeFactory as never);
    await mgr.connect({ myserver: { command: "irrelevant" } });
    expect(mgr.tools().map(t => t.name)).toEqual(["mcp__myserver__search"]);
    expect(mgr.status()).toEqual([{ name: "myserver", status: "connected" }]);
    const out = await mgr.tools()[0].execute({}, { cwd: "." });
    expect(out.content).toContain("ran:search");
  });
  it("records failed servers without throwing", async () => {
    const mgr = new McpManager((async () => { throw new Error("spawn failed"); }) as never);
    await mgr.connect({ bad: { command: "nope" } });
    expect(mgr.status()).toEqual([{ name: "bad", status: "failed" }]);
    expect(mgr.tools()).toEqual([]);
  });
});
