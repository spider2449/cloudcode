import { vi } from "vitest";
import type { CommandContext } from "../../src/commands/types.js";
import { NetworkPolicy } from "../../src/agent/networkPolicy.js";

// Shared mock CommandContext for slash-command tests (commands.test.ts,
// commands-config.test.ts, ...). Each test file still declares its own
// vi.mock blocks and beforeEach reset; this factory only builds the object.
export function mockCtx(): CommandContext {
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
      snapshot: { systemTokens: 1000, toolsTokens: 3000, messagesTokens: 6000, inputTokens: 20000 },
      model: "claude-sonnet-5",
      contextWindow: 200_000
    }),
    providerNames: vi.fn().mockReturnValue(["anthropic", "local"]),
    exit: vi.fn(),
    listPermissionRules: vi.fn().mockReturnValue("✓ Write /p/src"),
    clearPermissionRules: vi.fn(),
    mcpStatus: vi.fn().mockResolvedValue("github  connected  tools: get_repo"),
    mcpSetEnabled: vi.fn().mockResolvedValue("Disabled gh (project). Use /clear to reconnect."),
    sendPrompt: vi.fn(),
    compact: vi.fn().mockResolvedValue(undefined),
    setCompactProgress: vi.fn(),
    listSkills: vi.fn().mockReturnValue("/a  does a  (project)"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue("● dark\n  light\n  mono"),
    switchProject: vi.fn(),
    openProjectPicker: vi.fn(),
    currentCwd: vi.fn().mockReturnValue(process.cwd()),
    setEffort: vi.fn().mockResolvedValue(undefined),
    currentEffort: vi.fn().mockReturnValue("off"),
    openMemoryPicker: vi.fn(),
    openStatusLinePicker: vi.fn(),
    openConfigPicker: vi.fn(),
    openThemePicker: vi.fn(),
    changeSummaries: vi.fn().mockReturnValue([]),
    changeDiff: vi.fn().mockReturnValue({ content: "No session-owned changes.", truncated: false }),
    previewUndo: vi.fn().mockReturnValue({ operations: [], conflicts: [] }),
    undoLatest: vi.fn().mockReturnValue({ applied: false, operations: [], conflicts: [], rollbackErrors: [] }),
    gitReview: vi.fn().mockResolvedValue({ isGitRepo: true, status: "", diff: "", truncated: false })
    , currentNetworkMode: vi.fn().mockReturnValue("providerOnly")
    , setNetworkMode: vi.fn().mockResolvedValue(undefined)
    , setSessionNetworkMode: vi.fn().mockResolvedValue(undefined)
    , networkPolicy: vi.fn().mockReturnValue(new NetworkPolicy("providerOnly", "https://api.anthropic.com"))
  };
}
