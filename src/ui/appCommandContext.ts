import type { PermissionMode } from "../agent/session.js";
import type { EffortLevel } from "../engine/effort.js";
import type { NetworkMode, NetworkPolicy } from "../agent/networkPolicy.js";
import type { ProviderConfig } from "../agent/providers.js";
import type { StatusLineItem } from "../statusLineItems.js";
import type { CommandContext } from "../commands/types.js";
import type { PermissionRule } from "../agent/permissionStore.js";
import { applyConfigValue, configChoices, type ConfigKey } from "../commands/builtins.js";
import {
  openConfigPicker, openMemoryPicker, openProjectPicker, openResumePicker,
  openStatusLinePicker, openThemePicker, type PickerDeps
} from "./appPickers.js";
import { THEMES, loadThemeName } from "./theme.js";

// State the TUI App lends its CommandContext assembly. App keeps owning every
// field (the desktop's buildGuiCommandContext works the same way behind
// GuiCommandDeps); this module owns the context shape so nativeApp.ts stays
// under the module-size ceiling.
export interface AppCommandDeps {
  readonly cwd: string;
  readonly providers: Record<string, ProviderConfig>;
  notice(text: string): void;
  clearTranscript(): void;
  recompute(): void;
  restartSession(name?: string): Promise<void>;
  providerName(): string;
  availableModels(): string[];
  currentModel(): string | undefined;
  setModel(m: string): Promise<void>;
  currentEffort(): EffortLevel;
  setEffort(level: EffortLevel): Promise<void>;
  setPermissionMode(m: PermissionMode): Promise<void>;
  currentNetworkMode(): NetworkMode;
  setNetworkMode(mode: Exclude<NetworkMode, "unrestricted">): Promise<void>;
  setSessionNetworkMode(mode: NetworkMode): Promise<void>;
  networkPolicy(): NetworkPolicy;
  switchProvider(name: string): Promise<void>;
  compact(onProgress?: (pct: number) => void): Promise<number | undefined>;
  setCompactProgress(pct: number | undefined): void;
  pickResume(e: { id: string; provider: string }): void;
  costSummary(): string;
  contextInfo(): ReturnType<CommandContext["contextInfo"]>;
  exit(): void;
  listPermissionRules(): string;
  clearPermissionRules(): void;
  mcpStatus(): ReturnType<CommandContext["mcpStatus"]>;
  mcpSetEnabled(name: string, enabled: boolean): Promise<string>;
  sendPrompt(text: string): void;
  listSkills(): string;
  reloadSkills(): void;
  setTheme(name: string): void;
  listThemes(): string;
  switchProject(path: string): void;
  pickers(): PickerDeps;
  statusLineItems(): StatusLineItem[];
  setStatusLineItems(next: StatusLineItem[]): void;
  applyThemeUnsaved(name: string): void;
  refreshSystemPrompt(): void;
  changeSummaries(latestOnly?: boolean): ReturnType<CommandContext["changeSummaries"]>;
  changeDiff(path?: string): ReturnType<CommandContext["changeDiff"]>;
  previewUndo(): ReturnType<CommandContext["previewUndo"]>;
  undoLatest(): ReturnType<CommandContext["undoLatest"]>;
  gitReview(stagedOnly?: boolean): ReturnType<CommandContext["gitReview"]>;
  self(): CommandContext;
}

// Pure formatting for /permissions list, shared so the TUI and any future
// shell render remembered rules identically.
export function formatPermissionRules(rules: PermissionRule[]): string {
  if (rules.length === 0) return "No permission rules.";
  return rules.map(r => {
    const scope = r.dir ?? (r.host !== undefined ? r.host : `'${r.prefix}' commands`);
    return `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${scope}`;
  }).join("\n");
}

export function buildAppCommandContext(deps: AppCommandDeps): CommandContext {
  return {
    notice: text => deps.notice(text),
    clearSession: async () => {
      deps.clearTranscript();
      await deps.restartSession();
      deps.recompute();
    },
    setModel: async m => { await deps.setModel(m); deps.recompute(); },
    availableModels: () => deps.availableModels(),
    currentModel: () => deps.currentModel(),
    setEffort: async level => { await deps.setEffort(level); },
    currentEffort: () => deps.currentEffort(),
    setPermissionMode: async m => {
      await deps.setPermissionMode(m as PermissionMode);
      deps.recompute();
    },
    currentNetworkMode: () => deps.currentNetworkMode(),
    setNetworkMode: async networkMode => {
      await deps.setNetworkMode(networkMode);
      deps.recompute();
    },
    setSessionNetworkMode: async mode => {
      await deps.setSessionNetworkMode(mode);
      deps.recompute();
    },
    networkPolicy: () => deps.networkPolicy(),
    switchProvider: async name => {
      await deps.switchProvider(name);
      deps.recompute();
    },
    compact: async onProgress => deps.compact(onProgress),
    setCompactProgress: pct => { deps.setCompactProgress(pct); deps.recompute(); },
    openResumePicker: () => openResumePicker(deps.pickers(), e => deps.pickResume(e)),
    costSummary: () => deps.costSummary(),
    contextInfo: () => deps.contextInfo(),
    providerNames: () => Object.keys(deps.providers),
    exit: () => deps.exit(),
    listPermissionRules: () => deps.listPermissionRules(),
    clearPermissionRules: () => deps.clearPermissionRules(),
    mcpStatus: () => deps.mcpStatus(),
    mcpSetEnabled: (name, enabled) => deps.mcpSetEnabled(name, enabled),
    sendPrompt: text => deps.sendPrompt(text),
    listSkills: () => deps.listSkills(),
    reloadSkills: () => deps.reloadSkills(),
    setTheme: name => deps.setTheme(name),
    listThemes: () => deps.listThemes(),
    switchProject: path => deps.switchProject(path),
    openProjectPicker: () => openProjectPicker(deps.pickers(), path => deps.self().switchProject(path)),
    openMemoryPicker: () =>
      openMemoryPicker(deps.pickers(), () => deps.refreshSystemPrompt()),
    openStatusLinePicker: () =>
      openStatusLinePicker(deps.pickers(), deps.statusLineItems(), next => {
        deps.setStatusLineItems(next); deps.recompute();
      }),
    openConfigPicker: () =>
      openConfigPicker(
        deps.pickers(),
        configChoices(deps.self()),
        (key, value) => {
          void applyConfigValue(deps.self(), key as ConfigKey, value);
        },
        (key, value) => {
          // Live preview while browsing the picker's values: rendered
          // without saving, so Esc restores the saved theme and only Enter
          // persists. Other keys ignore the highlight and apply on Enter
          // via applyConfigValue as before.
          if (key === "theme") deps.applyThemeUnsaved(value);
        }
      ),
    openThemePicker: () =>
      openThemePicker(
        deps.pickers(),
        Object.keys(THEMES),
        loadThemeName(),
        name => {
          deps.self().setTheme(name);
          deps.notice(`Theme: ${name}`);
        },
        name => deps.applyThemeUnsaved(name)
      ),
    currentCwd: () => deps.cwd,
    changeSummaries: latestOnly => deps.changeSummaries(latestOnly),
    changeDiff: path => deps.changeDiff(path),
    previewUndo: () => deps.previewUndo(),
    undoLatest: () => deps.undoLatest(),
    gitReview: stagedOnly => deps.gitReview(stagedOnly)
  };
}
