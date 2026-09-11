import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/commands/builtins.js";
import { runSlashCommand } from "../src/commands/runtime.js";
import type { CommandContext } from "../src/commands/types.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import type { ProviderConfig } from "../src/agent/providers.js";
import { buildGuiCommandContext, type GuiCommandDeps, type GuiCommandSession } from "../src/desktop/guiCommandContext.js";

function fakeSession(): GuiCommandSession & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    tools: [],
    sessionId: "sess-1",
    send: (text: string) => { sent.push(text); },
    setModel: async () => {},
    setEffort: async () => {},
    setPermissionMode: async () => {},
    mcpStatus: async () => [],
    changeSummaries: () => [],
    changeDiff: () => ({ content: "No session-owned changes.", truncated: false }),
    previewUndo: () => ({ operations: [], conflicts: [] }),
    undoLatest: () => ({ applied: false, operations: [], conflicts: [], rollbackErrors: [] }),
    compact: async () => undefined,
    contextSnapshot: () => undefined
  };
}

function setup() {
  const notices: string[] = [];
  const newSessionRequests: string[] = [];
  const errors: unknown[] = [];
  const session = fakeSession();
  const store = new PermissionStore(mkdtempSync(join(tmpdir(), "gui-perm-")));
  const providers = {
    alpha: { model: "a-model" },
    beta: { model: "b-model" }
  } as unknown as Record<string, ProviderConfig>;
  let providerName = "alpha";
  let model: string | undefined = "a-model";
  const deps: GuiCommandDeps = {
    cwd: mkdtempSync(join(tmpdir(), "gui-cwd-")),
    notice: text => { notices.push(text); },
    providers,
    providerName: () => providerName,
    availableModels: () => ["a-model", "a-other"],
    currentModel: () => model,
    setCurrentModel: m => { model = m; },
    currentEffort: () => "off",
    setCurrentEffort: () => {},
    currentNetworkMode: () => "providerOnly",
    setCurrentNetworkMode: () => {},
    sessionCost: () => 0.0123,
    getSession: () => session,
    restartSession: async (name?: string) => {
      if (name) providerName = name;
      return session;
    },
    requestNewSession: () => { newSessionRequests.push("new"); },
    mcpDisabled: () => new Set<string>(),
    permissionStore: () => store
  };
  const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
  async function slash(input: string): Promise<void> {
    await runSlashCommand(input, registry, ctx, {
      onUnknown: name => notices.push(`Unknown command: /${name}`),
      onError: err => { errors.push(err); }
    });
  }
  const ctx: CommandContext = buildGuiCommandContext(deps);
  return { notices, errors, session, slash, ctx, newSessionRequests };
}

describe("gui command context against the real registry", () => {
  it("runs /provider without crashing on the full context (reported bug)", async () => {
    const { notices, errors, slash } = setup();
    await slash("/provider");
    expect(errors).toEqual([]);
    expect(notices.some(n => n.includes("Providers:") && n.includes("alpha"))).toBe(true);
  });
  it("rejects unknown providers and switches known ones", async () => {
    const { notices, errors, slash } = setup();
    await slash("/provider nope");
    expect(errors).toEqual([]);
    expect(notices.some(n => n.includes("Unknown provider: nope"))).toBe(true);
    await slash("/provider beta");
    expect(errors).toEqual([]);
    expect(notices).toContain("Provider: beta");
  });
  it("lists models and permission rules", async () => {
    const { notices, errors, slash } = setup();
    await slash("/model");
    expect(errors).toEqual([]);
    expect(notices.some(n => n.includes("● a-model"))).toBe(true);
    await slash("/permissions list");
    expect(errors).toEqual([]);
    expect(notices).toContain("No permission rules.");
  });
  it("degrades terminal-only features to notices instead of crashing", async () => {
    const { notices, errors, slash, ctx } = setup();
    await slash("/resume");
    expect(errors).toEqual([]);
    expect(notices.some(n => n.includes("not available in the desktop GUI"))).toBe(true);
    ctx.exit();
    expect(notices.some(n => n.includes("Close the desktop window"))).toBe(true);
    expect(ctx.costSummary()).toBe("Session cost: $0.0123");
  });
  it("routes sendPrompt to the session like the TUI", async () => {
    const { errors, session, slash } = setup();
    await slash("/init");
    expect(errors).toEqual([]);
    expect(session.sent).toEqual(["/init"]);
  });
  it("reports current working directory", () => {
    const { ctx } = setup();
    expect(typeof ctx.currentCwd()).toBe("string");
  });
  it("/new restarts the backend session and requests a fresh anonymous session", async () => {
    const { errors, slash, newSessionRequests } = setup();
    await slash("/new");
    expect(errors).toEqual([]);
    expect(newSessionRequests).toEqual(["new"]);
  });
});
