import { describe, it, expect } from "vitest";
import type { ToolContext } from "../../src/engine/tools/types.js";
import { LspManager } from "../../src/engine/lsp/manager.js";

describe("ToolContext wiring", () => {
  it("accepts an optional LspManager", () => {
    const ctx: ToolContext = { cwd: "/x", lsp: new LspManager() };
    expect(ctx.lsp).toBeInstanceOf(LspManager);
  });
});
