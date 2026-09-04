import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry, applyConfigValue, configChoices, type ConfigKey } from "../commands/builtins.js";
import { runSlashCommand } from "../commands/runtime.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import { liveCompletionContext, type CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, streamThinkingDelta, transcriptToDisplayItems, type DisplayItem } from "./transcript.js";
import { fetchModels } from "../agent/models.js";
import { applyContextWindow } from "../agent/contextProbe.js";
import { loadMcpServers, loadMcpServersByScope, isMcpServerDisabled, resolveMcpServerScope, setMcpServerDisabled, formatMcpStatus } from "../agent/mcp.js";
import { loadRegistry } from "../engine/lsp/config.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { missingMentions } from "../commands/mentions.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { GitStatusPoller } from "./useGitStatus.js";
import { PermissionController } from "./permissionController.js";
import { KeyRouter, type KeyRouterHost } from "./keyRouter.js";
import { UsageTracker } from "./usageTracker.js";
import { openConfigPicker, openMemoryPicker, openProjectPicker, openResumePicker, openStatusLinePicker, type PickerDeps } from "./appPickers.js";
import { DEFAULT_STATUS_LINE_ITEMS, type StatusLineItem } from "../statusLineItems.js";
import { collectGitReview } from "../agent/gitReview.js";
import { Buffer } from "./buffer.js";
import { InputBox } from "./widgets/inputBox.js";
import { ImageAttachments } from "./imageAttachments.js";
import { InputQueue } from "./inputQueue.js";
import { ResizeGuard } from "./resizeGuard.js";
import { join } from "node:path";
import { OverlayManager } from "./widgets/overlay.js";
import { InlineRenderer, type BottomState } from "./term/render.js";
import { CLEAR_AND_HOME, sgr, SGR_RESET } from "./term/ansi.js";
import { truncateToWidth } from "./width.js";
import type { ITerminal } from "./term/terminal.js";
import type { Key } from "./input.js";
import { loadSettings, saveSetting } from "../agent/settings.js";
import { resolveProjectConfigTrust } from "./projectTrustPrompt.js";
import type { EffortLevel } from "../engine/effort.js";
import type { NetworkDecisionRecorder, NetworkMode } from "../agent/networkPolicy.js";
import { NetworkController } from "./networkController.js";
import { SessionPresentation } from "./sessionPresentation.js";
import { TaskUiController, type TaskUiOptions } from "./taskController.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  initialMode?: PermissionMode;
  resume?: string;
  sessionIndex: SessionIndex;
  openResumeOnStart?: boolean;
  onSwitchProject?: (path: string) => string | undefined;
  switchedFrom?: string;
  networkMode?: NetworkMode;
  networkAudit?: NetworkDecisionRecorder;
  oauthAuthToken?: string;
  task?: TaskUiOptions;
}

type Phase = "idle" | "streaming" | "permission";
const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

export class App {
  /** Test hook: called whenever auto-compact fires. */
  onAutoCompactForTest: (() => void) | undefined;

  private buffer = new Buffer();
  private inputBox: InputBox;
  private overlay = new OverlayManager();
  private theme = THEMES[loadThemeName()] ?? THEMES.dark;

  private phase: Phase = "idle";
  private streamText = "";
  private thinkingText = "";
  private activeTool: string | undefined;
  private providerName: string;
  private model: string | undefined;
  private effort: EffortLevel = loadSettings().effort ?? "off";
  private statusLineItems: StatusLineItem[] = loadSettings().statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS;
  private servedModel: string | undefined;
  private mode: PermissionMode;
  private network: NetworkController;
  private presentation: SessionPresentation;
  private task: TaskUiController;
  private permissions: PermissionController;
  // Messages submitted while a turn was in flight are owned by the queue;
  // sent FIFO, one per turn, when the agent returns to idle.
  private queue = new InputQueue();
  private usage: UsageTracker;
  private turnCount = 0;
  private startedAt = Date.now();
  private workStartedAt = 0;
  private workIndFrame = 0;
  private renderer = new InlineRenderer();

  private firstMessage: string | undefined;
  private session: AgentSession | undefined;
  private history = new History();
  private keys: KeyRouter;
  private resize: ResizeGuard;
  private permissionStore: PermissionStore;
  private registry = buildRegistry();
  private skills: Skill[] = [];
  private fileIndex: FileIndex;
  private availableModels: string[] = [];
  private mcpServers: Record<string, Record<string, unknown>> = {};
  private mcpDisabled = new Set<string>();
  private allowProjectConfig = false;
  private git: GitStatusPoller;
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  private ctx: CommandContext;
  private completionCtx: CompletionContext;

  constructor(private props: AppProps, private terminal: ITerminal) {
    this.providerName = props.initialProvider;
    this.presentation = new SessionPresentation(props.providers);
    this.task = new TaskUiController(props.task);
    this.model = this.presentation.modelFor(props.initialProvider);
    this.mode = props.initialMode ?? "default";
    this.network = new NetworkController(props.networkMode ?? "providerOnly", props.providers, props.networkAudit);
    this.permissionStore = new PermissionStore(props.cwd);
    this.fileIndex = new FileIndex(props.cwd);
    this.git = new GitStatusPoller(props.cwd);
    this.completionCtx = liveCompletionContext({
      registry: () => this.registry, providerNames: () => Object.keys(this.props.providers),
      availableModels: () => this.availableModels, listFiles: () => this.fileIndex.list(),
      refreshFiles: () => this.fileIndex.refresh()
    });
    this.inputBox = new InputBox(this.completionCtx, this.history);
    this.inputBox.onSubmit = text => this.handleSubmit(text);
    this.usage = new UsageTracker({
      contextWindow: () => this.presentation.contextWindowFor(this.providerName),
      compact: onProgress => this.session?.compact(onProgress) ?? Promise.resolve(undefined),
      notice: text => this.notice(text),
      onError: text => this.buffer.append({ kind: "error", text }),
      recompute: () => this.recompute(),
      onAutoCompact: () => this.onAutoCompactForTest?.()
    });
    this.permissions = new PermissionController({
      overlay: this.overlay,
      store: this.permissionStore,
      cwd: this.props.cwd,
      onError: text => this.buffer.append({ kind: "error", text }),
      onQueueEmpty: () => { this.phase = "streaming"; },
      recompute: () => this.recompute()
    });
    this.keys = new KeyRouter(this.keyRouterHost());
    this.resize = new ResizeGuard({
      isRunning: () => this.running,
      write: text => this.terminal.write(text),
      invalidateRenderer: () => this.renderer.invalidate(),
      recommitBuffer: () => this.buffer.recommitAll(),
      recompute: () => this.recompute()
    });
    this.pendingImages = new ImageAttachments({
      setAttachmentCount: n => { this.inputBox.attachmentCount = n; },
      notice: text => this.notice(text),
      recompute: () => this.recompute()
    });
    this.ctx = this.buildCommandContext();

    this.appendWelcome();
    this.buffer.append({ kind: "notice", text: this.network.notice() });
    if (props.switchedFrom) this.buffer.append({ kind: "notice", text: `Switched project to ${props.cwd}` });
  }

  /** Append the welcome banner to the buffer and pin the view to its top. */
  private appendWelcome(): void {
    const item = this.presentation.welcomeItem(this.providerName, this.terminal.size());
    if (item) this.buffer.append(item);
  }

  private notice(text: string): void {
    this.buffer.append({ kind: "notice", text });
  }

  private pickerDeps(): PickerDeps {
    return {
      overlay: this.overlay,
      cwd: this.props.cwd,
      sessionIndex: this.props.sessionIndex,
      notice: text => this.notice(text),
      recompute: () => this.recompute()
    };
  }

  handleMessage(msg: EngineMessage): void {
    this.task.handleMessage(msg, text => this.notice(text));
    const served = (msg as { message?: { model?: string } }).message?.model;
    if (served) this.servedModel = served;
    const thinking = streamThinkingDelta(msg);
    if (thinking) { this.thinkingText += thinking; this.recompute(); return; }
    const delta = streamDelta(msg);
    if (delta) { this.thinkingText = ""; this.streamText += delta; this.recompute(); return; }
    const mapped = toDisplayItems(msg);
    for (const item of mapped) this.buffer.append(item);
    if (mapped.some(i => i.kind === "assistant")) { this.streamText = ""; this.thinkingText = ""; this.activeTool = undefined; }
    const lastTool = [...mapped].reverse().find((i): i is Extract<DisplayItem, { kind: "tool" }> => i.kind === "tool");
    if (lastTool) this.activeTool = lastTool.label.split(" ")[0];

    const t = (msg as { type: string }).type;
    if (t === "result") {
      if (this.streamText) {
        this.buffer.append({ kind: "assistant", text: this.streamText });
        this.streamText = "";
      }
      this.thinkingText = "";
      this.activeTool = undefined;
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") this.usage.addCost(cost);
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) this.usage.applyTurnUsage(usage);
      this.turnCount += 1;
      void this.git.refresh().then(() => this.recompute());
      // Delay idle until the session's finally block closes the checkpoint;
      // otherwise a queued send races it as an overlapping turn.
      setTimeout(() => { if (this.running) { this.phase = "idle"; this.drainQueueIfIdle(); this.recompute(); } }, 0);
    }
    this.recompute();
  }

  /** If idle with pending queued messages, submit the next one. */
  private drainQueueIfIdle(): void {
    this.queue.drainIfIdle(
      () => this.phase === "idle",
      text => this.handleSubmit(text)
    );
  }
  private refreshSkills(): void {
    this.skills = loadSkills(this.props.cwd);
    this.registry = mergeSkillCommands(buildRegistry(), this.skills);
  }
  private createSession(name: string, resume?: string, modeOverride?: PermissionMode): AgentSession {
    this.availableModels = [];
    this.mcpServers = this.props.task?.disableMcp ? {} : loadMcpServers(this.props.cwd, undefined, this.allowProjectConfig);
    const scopes = loadMcpServersByScope(this.props.cwd);
    const visible = this.allowProjectConfig ? scopes : { user: scopes.user, project: {} as typeof scopes.project };
    this.mcpDisabled = new Set(
      Object.keys({ ...visible.user, ...visible.project }).filter(name => {
        const effective = visible.project[name] ?? visible.user[name];
        return effective ? isMcpServerDisabled(effective) : false;
      })
    );
    this.refreshSkills();
    const session = new AgentSession({
      providerName: name,
      provider: this.props.providers[name],
      model: this.presentation.modelFor(name),
      effort: this.effort,
      permissionMode: modeOverride ?? this.mode,
      resume,
      cwd: this.props.cwd,
      networkPolicy: this.network.policyFor(name),
      oauthAuthToken: this.props.oauthAuthToken,
      mcpServers: this.mcpServers,
      lspRegistry: loadRegistry(undefined, join(this.props.cwd, ".cloudcode", "lsp.json"), this.allowProjectConfig),
      toolAllowlist: this.props.task?.toolAllowlist,
      onMessage: msg => this.handleMessage(msg),
      onPermissionRequest: req => {
        this.phase = "permission";
        this.permissions.enqueue(req);
      },
      onSessionId: id => { this.task.sessionStarted(id); if (this.firstMessage) this.recordSession(id, name); }
    });
    session.start();
    if (resume) {
      for (const item of transcriptToDisplayItems(session.getResumedTranscript())) {
        this.buffer.append(item);
      }
    }
    void fetchModels(this.props.providers[name] ?? {}).then(models => { this.availableModels = models; });
    return session;
  }

  private recordSession(id: string, provider: string): void {
    this.props.sessionIndex.record({
      id, cwd: this.props.cwd, firstMessage: this.firstMessage ?? "", timestamp: new Date().toISOString(), provider
    });
  }

  private async restartSession(name: string, resume?: string, modeOverride?: PermissionMode): Promise<void> {
    await this.session?.dispose();
    await applyContextWindow(this.props.providers[name]);
    this.firstMessage = undefined;
    this.usage.resetForNewSession();
    this.session = this.createSession(name, resume, modeOverride);
    this.model = this.presentation.modelFor(name);
    this.servedModel = undefined;
  }

  private pickResume(e: { id: string; provider: string }): void {
    this.overlay.close();
    this.buffer.clear();
    this.terminal.write(CLEAR_AND_HOME);
    this.renderer.invalidate();
    const provider = this.props.providers[e.provider] ? e.provider : this.providerName;
    this.providerName = provider;
    this.model = this.props.providers[provider]?.model;
    void this.restartSession(provider, e.id);
  }

  private buildCommandContext(): CommandContext {
    return {
      notice: text => this.notice(text),
      clearSession: async () => {
        this.buffer.clear();
        this.terminal.write(CLEAR_AND_HOME);
        this.renderer.invalidate();
        this.streamText = "";
        this.thinkingText = "";
        this.activeTool = undefined;
        this.appendWelcome();
        await this.restartSession(this.providerName);
        this.recompute();
      },
      setModel: async m => { await this.session?.setModel(m); this.model = m; this.servedModel = undefined; this.recompute(); },
      availableModels: () => this.availableModels,
      currentModel: () => this.model,
      setEffort: async level => { await this.session?.setEffort(level); this.effort = level; },
      currentEffort: () => this.effort,
      setPermissionMode: async m => {
        const pm = m as PermissionMode;
        await this.session?.setPermissionMode(pm);
        if (pm !== "bypassPermissions") saveSetting("permissionMode", pm);
        this.mode = pm;
        this.recompute();
      },
      currentNetworkMode: () => this.network.mode,
      setNetworkMode: async networkMode => {
        this.network.setMode(networkMode);
        saveSetting("networkMode", networkMode);
        await this.restartSession(this.providerName);
        this.recompute();
      },
      setSessionNetworkMode: async mode => {
        this.network.setMode(mode);
        this.recompute();
      },
      networkPolicy: () => this.network.policyFor(this.providerName),
      switchProvider: async name => {
        if (!this.props.providers[name]) {
          this.notice(`Unknown provider: ${name}. Providers: ${Object.keys(this.props.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
          return;
        }
        const previous = this.providerName;
        try {
          await this.restartSession(name);
          this.providerName = name;
          this.model = this.presentation.modelFor(name);
          this.notice(`Provider: ${name}`);
        } catch (err) {
          this.notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
          await this.restartSession(previous);
        }
        this.recompute();
      },
      compact: async onProgress => {
        const estimatedTokens = await this.session?.compact(onProgress);
        this.usage.applyCompactedSize(estimatedTokens);
        return estimatedTokens;
      },
      setCompactProgress: pct => { this.usage.setCompactProgress(pct); this.recompute(); },
      openResumePicker: () => openResumePicker(this.pickerDeps(), e => this.pickResume(e)),
      costSummary: () => `Session cost: $${this.usage.cost.toFixed(4)}`,
      contextInfo: () => ({
        snapshot: this.session?.contextSnapshot(),
        model: this.presentation.modelFor(this.providerName) ?? "unknown",
        contextWindow: this.presentation.contextWindowFor(this.providerName)
      }),
      providerNames: () => Object.keys(this.props.providers),
      exit: () => { void this.session?.dispose(); this.stop(); },
      listPermissionRules: () => {
        const rules = this.permissionStore.list();
        if (rules.length === 0) return "No permission rules.";
        return rules.map(r => {
          const scope = r.dir ?? (r.host !== undefined ? r.host : `'${r.prefix}' commands`);
          return `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${scope}`;
        }).join("\n");
      },
      clearPermissionRules: () => this.permissionStore.clear(),
      mcpStatus: async () =>
        formatMcpStatus(
          [...Object.keys(this.mcpServers), ...this.mcpDisabled],
          (await this.session?.mcpStatus()) ?? [],
          this.session?.tools ?? [],
          this.mcpDisabled
        ),
      mcpSetEnabled: async (name, enabled) => {
        const scope = resolveMcpServerScope(name, this.props.cwd);
        if (!scope) return `No MCP server named "${name}".`;
        if (name.startsWith("pack__")) return `Pack servers cannot be disabled (${name}).`;
        try {
          setMcpServerDisabled(name, !enabled, scope, this.props.cwd);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        if (enabled) this.mcpDisabled.delete(name);
        else this.mcpDisabled.add(name);
        const verb = enabled ? "Enabled" : "Disabled";
        return `${verb} ${name} (${scope}). Use /clear to reconnect.`;
      },
      sendPrompt: text => this.sendUserMessage(text),
      listSkills: () => formatSkillList(this.skills),
      reloadSkills: () => this.refreshSkills(),
      setTheme: name => { this.theme = THEMES[name] ?? this.theme; saveThemeName(name); this.recompute(); },
      listThemes: () => Object.keys(THEMES).map(n => `${n === loadThemeName() ? "●" : " "} ${n}`).join("\n"),
      switchProject: path => {
        if (!this.props.onSwitchProject) { this.notice("Project switching is not available."); return; }
        const err = this.props.onSwitchProject(path);
        if (err) { this.notice(err); return; }
        void this.session?.dispose();
        this.stop();
      },
      openProjectPicker: () => openProjectPicker(this.pickerDeps(), path => this.ctx.switchProject(path)),
      openMemoryPicker: () =>
        openMemoryPicker(this.pickerDeps(), () => { void this.session?.refreshSystemPrompt(); }),
      openStatusLinePicker: () =>
        openStatusLinePicker(this.pickerDeps(), this.statusLineItems, next => {
          this.statusLineItems = next; saveSetting("statusLineItems", next); this.recompute();
        }),
      openConfigPicker: () =>
        openConfigPicker(this.pickerDeps(), configChoices(this.ctx), (key, value) => {
          void applyConfigValue(this.ctx, key as ConfigKey, value);
        }),
      currentCwd: () => this.props.cwd,
      changeSummaries: latestOnly => this.session?.changeSummaries(latestOnly) ?? [], changeDiff: path =>
        this.session?.changeDiff(path) ?? { content: "No session-owned changes.", truncated: false },
      previewUndo: () => this.session?.previewUndo() ?? { operations: [], conflicts: [] }, undoLatest: () =>
        this.session?.undoLatest() ?? { applied: false, operations: [], conflicts: [], rollbackErrors: [] },
      gitReview: stagedOnly => collectGitReview(this.props.cwd, stagedOnly)
    };
  }

  private sendUserMessage(text: string): void {
    if (!this.firstMessage) {
      this.firstMessage = text;
      if (this.session?.sessionId) this.recordSession(this.session.sessionId, this.providerName);
    }
    for (const path of missingMentions(text, this.props.cwd)) this.notice(`Note: ${path} does not exist (yet)`);
    this.buffer.append({ kind: "user", text });
    const images = this.pendingImages.takeForSend();
    this.phase = "streaming";
    this.workStartedAt = Date.now();
    this.session?.send(text, images);
    this.recompute();
  }

  private handleSubmit(text: string): void {
    if (this.phase === "streaming") {
      // The agent is mid-turn: queue the message and send it when idle.
      // Slash parsing happens at dequeue time so queued commands run in order.
      this.queue.enqueue(text);
      this.recompute();
      return;
    }
    const command = runSlashCommand(text, this.registry, this.ctx, {
      onUnknown: name => this.notice(`Unknown command: /${name}`),
      onError: err => this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) }),
      onSettled: () => {
        if (!this.running) return;
        this.recompute();
        this.drainQueueIfIdle();
      }
    });
    if (command) {
      return;
    }
    this.sendUserMessage(text);
  }

  /** Test helper: submits text as if typed and Enter pressed, bypassing key decoding. */
  submitForTest(text: string): void {
    this.handleSubmit(text);
  }

  /** Test helper: reports whether the App's run loop is still active. */
  isRunningForTest(): boolean {
    return this.running;
  }

  /** Test helper: opens the resume picker overlay as /resume would. */
  openResumePickerForTest(): void {
    this.ctx.openResumePicker();
  }

  tick(): void {
    if (this.phase === "idle" && this.usage.compactPct === undefined) return;
    this.workIndFrame += 1;
    this.recompute();
  }

  private pendingImages: ImageAttachments;

  private keyRouterHost(): KeyRouterHost {
    return {
      isStreaming: () => this.phase === "streaming",
      isOverlayOpen: () => this.overlay.isOpen,
      interrupt: () => { void this.session?.interrupt(); },
      clearScreen: () => { this.terminal.write(CLEAR_AND_HOME); this.renderer.invalidate(); },
      exit: () => this.ctx.exit(),
      notice: text => this.notice(text),
      cyclePermissionMode: () => {
        const next = MODE_CYCLE[(MODE_CYCLE.indexOf(this.mode) + 1) % MODE_CYCLE.length];
        this.ctx.setPermissionMode(next).catch(err => {
          this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
          this.recompute();
        });
      },
      handleOverlayKey: (k, input) => this.overlay.handleKey(k, input),
      handlePaste: text => this.inputBox.handlePaste(text),
      handleInputKey: k => {
        this.inputBox.handleKey(k);
        if (k.t === "esc" && this.pendingImages.count > 0) {
          this.pendingImages.clear();
          this.notice("Attachments cleared.");
        }
      },
      attachImage: () => this.pendingImages.attachFromClipboard(),
      recompute: () => this.recompute()
    };
  }

  handleKeys(ks: Key[]): void { this.keys.handleKeys(ks); }
  handleKey(k: Key): void { this.keys.handleKey(k); }

  recompute(): void {
    const size = this.terminal.size();
    const inputVisible = this.overlay.mode === "none" && this.phase !== "permission";
    const queueCode = sgr(this.theme.muted);
    const queuedRows = this.queue.items().map(m => {
      const row = truncateToWidth(`⧉ queued: ${m.replace(/\n/g, " ")}`, Math.max(1, size.columns));
      return queueCode ? `${queueCode}${row}${SGR_RESET}` : row;
    });
    const bottom: BottomState = {
      overlay: this.overlay.mode,
      streaming: this.phase === "streaming",
      streamingText: this.streamText,
      thinkingText: this.thinkingText,
      activeTool: this.activeTool,
      compactPct: this.usage.compactPct,
      queuedRows,
      inputRender: inputVisible
        ? this.inputBox.render(this.theme, size.columns, this.phase === "streaming")
        : { borderRows: [], contentRows: [], menuRows: [], hintRow: null, totalRows: 0, cursorRow: 0, cursorColumn: 0 },
      overlayRows: this.overlay.isOpen ? this.overlay.render(this.theme, size.columns) : [],
      statusBarProps: {
        provider: this.providerName,
        model: this.model,
        servedModel: this.servedModel,
        effort: this.effort,
        mode: this.mode,
        networkMode: this.network.mode,
        cwd: this.props.cwd,
        costUsd: this.usage.cost,
        gitBranch: this.git.status.branch,
        gitDirty: this.git.status.dirty,
        tokens: this.usage.tokens,
        contextPct: this.usage.contextPct,
        elapsedMs: Date.now() - this.startedAt,
        items: this.statusLineItems
      },
      workIndFrame: this.workIndFrame,
      workStartedAt: this.workStartedAt
    };
    this.terminal.write(this.renderer.frame(this.buffer, bottom, this.theme, size));
  }

  async run(): Promise<void> {
    this.running = true;
    this.git.start();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.terminal.onResize(() => this.resize.handleResize());
    this.terminal.onKeys(keys => this.handleKeys(keys));
    this.terminal.onLine(line => this.handleSubmit(line));
    const trust = resolveProjectConfigTrust({
      cwd: this.props.cwd,
      openTrust: (projectPath, commands, resolve) => this.overlay.openTrust(projectPath, commands, resolve),
      notice: text => this.notice(text),
      onError: text => this.buffer.append({ kind: "error", text }),
      recompute: () => this.recompute()
    });
    this.allowProjectConfig = typeof trust === "boolean" ? trust : await trust;
    this.session = this.createSession(this.props.initialProvider, this.props.resume);
    const initialPrompt = this.task.takeInitialPrompt();
    if (initialPrompt) this.handleSubmit(initialPrompt);
    if (this.props.openResumeOnStart) this.openResumePickerForTest();
    this.recompute();
    // Some terminals (e.g. VS Code's) report a stale rows/columns size for the
    // first tick or two after the process attaches, before layout settles, and
    // don't always follow up with a real "resize" event. Re-paint shortly after
    // startup so the frame reflects the settled size instead of a stale one.
    setTimeout(() => { if (this.running) this.recompute(); }, 50);
    await new Promise<void>(resolve => { this.stopResolve = resolve; });
  }
  private stopResolve: (() => void) | undefined;
  private stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.resize.dispose();
    this.git.stop();
    this.terminal.write(this.renderer.finalize());
    this.running = false;
    this.stopResolve?.();
  }
}
