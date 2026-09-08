import { describe, it, expect, vi } from "vitest";
import { buildRegistry, isDesktopGui } from "../src/commands/builtins.js";
import type { CommandContext } from "../src/commands/types.js";
import { NetworkPolicy } from "../src/agent/networkPolicy.js";

vi.mock("../src/agent/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({}),
  saveSetting: vi.fn()
}));
vi.mock("../src/ui/theme.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ui/theme.js")>()),
  loadThemeName: vi.fn().mockReturnValue("dark")
}));

function mockCtx(): CommandContext {
  return {
    notice: vi.fn(),
    clearSession: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    availableModels: vi.fn().mockReturnValue([]),
    currentModel: vi.fn().mockReturnValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    openResumePicker: vi.fn(),
    costSummary: vi.fn().mockReturnValue("$0.01"),
    contextInfo: vi.fn().mockReturnValue({
      snapshot: { systemTokens: 1, toolsTokens: 1, messagesTokens: 1, inputTokens: 3 },
      model: "m",
      contextWindow: 200_000
    }),
    providerNames: vi.fn().mockReturnValue(["anthropic"]),
    exit: vi.fn(),
    listPermissionRules: vi.fn().mockReturnValue(""),
    clearPermissionRules: vi.fn(),
    mcpStatus: vi.fn().mockResolvedValue(""),
    mcpSetEnabled: vi.fn().mockResolvedValue(""),
    sendPrompt: vi.fn(),
    compact: vi.fn().mockResolvedValue(undefined),
    setCompactProgress: vi.fn(),
    listSkills: vi.fn().mockReturnValue(""),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue(""),
    switchProject: vi.fn(),
    openProjectPicker: vi.fn(),
    currentCwd: vi.fn().mockReturnValue(process.cwd()),
    setEffort: vi.fn().mockResolvedValue(undefined),
    currentEffort: vi.fn().mockReturnValue("off"),
    openMemoryPicker: vi.fn(),
    openStatusLinePicker: vi.fn(),
    openConfigPicker: vi.fn(),
    changeSummaries: vi.fn().mockReturnValue([]),
    changeDiff: vi.fn().mockReturnValue({ content: "", truncated: false }),
    previewUndo: vi.fn().mockReturnValue({ operations: [], conflicts: [] }),
    undoLatest: vi.fn().mockReturnValue({ applied: false, operations: [], conflicts: [], rollbackErrors: [] }),
    gitReview: vi.fn().mockResolvedValue({ isGitRepo: false, status: "", diff: "", truncated: false }),
    currentNetworkMode: vi.fn().mockReturnValue("providerOnly"),
    setNetworkMode: vi.fn().mockResolvedValue(undefined),
    setSessionNetworkMode: vi.fn().mockResolvedValue(undefined),
    networkPolicy: vi.fn().mockReturnValue(new NetworkPolicy("providerOnly", "https://api.anthropic.com"))
  };
}

describe("desktop GUI /exit", () => {
  it("detects desktop mode via CLOUDCODE_DESKTOP", () => {
    expect(isDesktopGui({ CLOUDCODE_DESKTOP: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDesktopGui({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("excludes /exit from registry in desktop GUI mode", () => {
    expect(buildRegistry({ CLOUDCODE_DESKTOP: "1" } as NodeJS.ProcessEnv).has("exit")).toBe(false);
    expect(buildRegistry({} as NodeJS.ProcessEnv).has("exit")).toBe(true);
  });

  it("excludes /exit from /help in desktop GUI mode", async () => {
    const prev = process.env.CLOUDCODE_DESKTOP;
    process.env.CLOUDCODE_DESKTOP = "1";
    try {
      const ctx = mockCtx();
      await buildRegistry().get("help")!.run(ctx, "");
      const output = vi.mocked(ctx.notice).mock.calls[0]?.[0] as string;
      expect(output).not.toContain("/exit");
    } finally {
      if (prev === undefined) delete process.env.CLOUDCODE_DESKTOP;
      else process.env.CLOUDCODE_DESKTOP = prev;
    }
  });
});
