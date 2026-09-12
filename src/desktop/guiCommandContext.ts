import type { ProviderConfig } from "../agent/providers.js";
import { DEFAULT_CONTEXT_WINDOW } from "../agent/providers.js";
import type { PermissionMode } from "../agent/session.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { NetworkPolicy, providerEndpoint, type NetworkMode } from "../agent/networkPolicy.js";
import { loadSkills, formatSkillList } from "../agent/skills.js";
import {
  loadMcpServers, formatMcpStatus, resolveMcpServerScope, setMcpServerDisabled,
  type McpServerStatusEntry
} from "../agent/mcp.js";
import { collectGitReview } from "../agent/gitReview.js";
import type { ChangeSummary, UndoPreview, UndoResult } from "../agent/changeJournal.js";
import type { ContextSnapshot } from "../engine/loop.js";
import type { EffortLevel } from "../engine/effort.js";
import type { CommandContext } from "../commands/types.js";
import { missingMentions } from "../commands/mentions.js";
import { THEMES, loadThemeName, saveThemeName } from "../ui/theme.js";
import { loadSettings, saveSetting } from "../agent/settings.js";
import { DEFAULT_STATUS_LINE_ITEMS } from "../statusLineItems.js";

// Structural subset of AgentSession consumed by slash commands. AgentSession
// satisfies this interface; tests substitute fakes.
export interface GuiCommandSession {
  tools: string[];
  sessionId: string | undefined;
  send(text: string): void;
  setModel(model: string): Promise<void>;
  setEffort(level: EffortLevel): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  mcpStatus(): Promise<McpServerStatusEntry[]>;
  changeSummaries(latestOnly?: boolean): ChangeSummary[];
  changeDiff(path?: string): { content: string; truncated: boolean };
  previewUndo(): UndoPreview;
  undoLatest(): UndoResult;
  compact(onProgress?: (pct: number) => void): Promise<number | undefined>;
  contextSnapshot(): ContextSnapshot | undefined;
}

export interface GuiCommandDeps {
  cwd: string;
  notice(text: string): void;
  providers: Record<string, ProviderConfig>;
  providerName(): string;
  availableModels(): string[];
  currentModel(): string | undefined;
  setCurrentModel(model: string): void;
  currentEffort(): EffortLevel;
  setCurrentEffort(level: EffortLevel): void;
  currentNetworkMode(): NetworkMode;
  // persist=true writes the setting to disk (mirrors the TUI); session-only
  // changes stay in memory for this backend lifetime.
  setCurrentNetworkMode(mode: NetworkMode, persist: boolean): void;
  sessionCost(): number;
  getSession(): GuiCommandSession;
  // Disposes the live session and creates a fresh one (same or new provider).
  restartSession(provider?: string): Promise<GuiCommandSession>;
  // Switches the GUI shell to a fresh anonymous session (the New Session
  // button path). Invoked by /new and /clear so slash and button stay identical.
  requestNewSession(): void;
  // Pushes a live "theme" chat event to the GUI shell so /theme recolors
  // the running window instead of only persisting for next launch.
  emitTheme(name: string): void;
  mcpDisabled(): Set<string>;
  permissionStore(): PermissionStore;
  // Opens the desktop statusline picker (a renderer dialog). The TUI calls
  // openStatusLinePicker on the terminal overlay; headless backends emit a
  // "statusline_picker" chat event the shell renders instead.
  emitStatusLinePicker(): void;
}

function guiOnly(feature: string, hint: string): string {
  return `${feature} picker is not available in the desktop GUI yet. ${hint}`;
}

// Builds the full CommandContext for headless backends (desktop gui-server).
// Mirrors App.buildCommandContext in ui/nativeApp.ts: every session-backed
// method delegates to the per-workspace AgentSession, provider/model state
// comes from the host layer, and terminal-overlay features degrade to
// notices instead of crashing (the bug they replace: a {notice}-only stub
// that threw `ctx.providerNames is not a function` on real commands).
export function buildGuiCommandContext(deps: GuiCommandDeps): CommandContext {
  const provider = (): ProviderConfig => deps.providers[deps.providerName()];
  return {
    notice: text => deps.notice(text),
    clearSession: async () => {
      await deps.restartSession();
      deps.requestNewSession();
    },
    setModel: async m => {
      await deps.getSession().setModel(m);
      deps.setCurrentModel(m);
    },
    setEffort: async level => {
      await deps.getSession().setEffort(level);
      deps.setCurrentEffort(level);
    },
    currentEffort: () => deps.currentEffort(),
    availableModels: () => deps.availableModels(),
    currentModel: () => deps.currentModel(),
    setPermissionMode: async m => {
      const pm = m as PermissionMode;
      await deps.getSession().setPermissionMode(pm);
      if (pm !== "bypassPermissions") saveSetting("permissionMode", pm);
    },
    currentNetworkMode: () => deps.currentNetworkMode(),
    setNetworkMode: async networkMode => {
      deps.setCurrentNetworkMode(networkMode, true);
      saveSetting("networkMode", networkMode);
      await deps.restartSession();
    },
    setSessionNetworkMode: async mode => {
      deps.setCurrentNetworkMode(mode, false);
    },
    networkPolicy: () => new NetworkPolicy(deps.currentNetworkMode(), providerEndpoint(provider())),
    switchProvider: async name => {
      if (!deps.providers[name]) {
        deps.notice(`Unknown provider: ${name}. Providers: ${Object.keys(deps.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
        return;
      }
      const previous = deps.providerName();
      try {
        await deps.restartSession(name);
        deps.notice(`Provider: ${name}`);
      } catch (err) {
        deps.notice(`Failed to switch provider: ${err instanceof Error ? err.message : String(err)}. Staying on ${previous}.`);
        await deps.restartSession(previous);
      }
    },
    compact: async onProgress => deps.getSession().compact(onProgress),
    // No progress bar headless: progress callbacks are accepted and ignored.
    setCompactProgress: () => {},
    openResumePicker: () => deps.notice(guiOnly("Session resume", "Pick a session in the sidebar instead.")),
    costSummary: () => `Session cost: $${deps.sessionCost().toFixed(4)}`,
    contextInfo: () => ({
      snapshot: deps.getSession().contextSnapshot(),
      model: deps.currentModel() ?? "unknown",
      contextWindow: provider().model_context_window ?? DEFAULT_CONTEXT_WINDOW
    }),
    providerNames: () => Object.keys(deps.providers),
    exit: () => deps.notice("Close the desktop window to quit CloudCode."),
    listPermissionRules: () => {
      const rules = deps.permissionStore().list();
      if (rules.length === 0) return "No permission rules.";
      return rules.map(r => {
        const scope = r.dir ?? (r.host !== undefined ? r.host : `'${r.prefix}' commands`);
        return `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${scope}`;
      }).join("\n");
    },
    clearPermissionRules: () => deps.permissionStore().clear(),
    mcpStatus: async () => {
      const servers = loadMcpServers(deps.cwd);
      return formatMcpStatus(
        [...Object.keys(servers), ...deps.mcpDisabled()],
        (await deps.getSession().mcpStatus()) ?? [],
        deps.getSession().tools ?? [],
        deps.mcpDisabled()
      );
    },
    mcpSetEnabled: async (name, enabled) => {
      const scope = resolveMcpServerScope(name, deps.cwd);
      if (!scope) return `No MCP server named "${name}".`;
      if (name.startsWith("pack__")) return `Pack servers cannot be disabled (${name}).`;
      try {
        setMcpServerDisabled(name, !enabled, scope, deps.cwd);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (enabled) deps.mcpDisabled().delete(name);
      else deps.mcpDisabled().add(name);
      const verb = enabled ? "Enabled" : "Disabled";
      return `${verb} ${name} (${scope}). Use /new to reconnect.`;
    },
    sendPrompt: text => {
      for (const path of missingMentions(text, deps.cwd)) deps.notice(`Note: ${path} does not exist (yet)`);
      deps.getSession().send(text);
    },
    listSkills: () => formatSkillList(loadSkills(deps.cwd)),
    // No-op: the headless registry is rebuilt from disk on every slash
    // invocation, so skills are always fresh without an explicit reload.
    reloadSkills: () => {},
    setTheme: name => {
      if (!THEMES[name]) {
        deps.notice(`Unknown theme: ${name}. Themes: ${Object.keys(THEMES).join(", ")}`);
        return;
      }
      saveThemeName(name);
      deps.emitTheme(name);
      deps.notice(`Theme set to ${name}.`);
    },
    listThemes: () => Object.keys(THEMES).map(n => `${n === loadThemeName() ? "●" : " "} ${n}`).join("\n"),
    switchProject: () => deps.notice("Switch projects from the desktop sidebar."),
    openProjectPicker: () => deps.notice(guiOnly("Project", "Use the desktop sidebar instead.")),
    openMemoryPicker: () => deps.notice(guiOnly("Memory", "Memory management UI is not available yet.")),
    openStatusLinePicker: () => {
      // Persist the current selection first so a fresh install writes the
      // default set to settings.json (mirrors the TUI toggle path).
      const current = loadSettings().statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS;
      saveSetting("statusLineItems", current);
      deps.emitStatusLinePicker();
    },
    openConfigPicker: () => deps.notice(guiOnly("Config", "Use /config <key> <value> instead.")),
    openThemePicker: () => deps.notice(guiOnly("Theme", "Use the titlebar Theme menu instead.")),
    currentCwd: () => deps.cwd,
    changeSummaries: latestOnly => deps.getSession().changeSummaries(latestOnly) ?? [],
    changeDiff: path => deps.getSession().changeDiff(path) ?? { content: "No session-owned changes.", truncated: false },
    previewUndo: () => deps.getSession().previewUndo() ?? { operations: [], conflicts: [] },
    undoLatest: () => deps.getSession().undoLatest() ?? { applied: false, operations: [], conflicts: [], rollbackErrors: [] },
    gitReview: stagedOnly => collectGitReview(deps.cwd, stagedOnly)
  };
}
