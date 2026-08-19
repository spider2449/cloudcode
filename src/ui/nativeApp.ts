import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import { liveCompletionContext, type CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, streamThinkingDelta, type DisplayItem } from "./transcript.js";
import { fetchModels } from "../agent/models.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "../agent/projectTrust.js";
import { loadRegistry } from "../engine/lsp/config.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { GitStatusPoller } from "./useGitStatus.js";
import { PermissionController } from "./permissionController.js";
import { KeyRouter, type KeyRouterHost } from "./keyRouter.js";
import { UsageTracker } from "./usageTracker.js";
import { openMemoryPicker, openProjectPicker, openResumePicker, type PickerDeps } from "./appPickers.js";
import { collectGitReview } from "../agent/gitReview.js";
import { Buffer } from "./buffer.js";
import { InputBox } from "./widgets/inputBox.js";
import { OverlayManager } from "./widgets/overlay.js";
import { InlineRenderer, type BottomState } from "./term/render.js";
import { CLEAR_AND_HOME, CLEAR_ALL_AND_HOME, sgr, SGR_RESET } from "./term/ansi.js";
import { truncateToWidth } from "./width.js";
import type { ITerminal } from "./term/terminal.js";
import type { Key } from "./input.js";
import { loadSettings, saveSetting } from "../agent/settings.js";
import type { EffortLevel } from "../engine/effort.js";
import { join } from "node:path";
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
  private servedModel: string | undefined;
  private mode: PermissionMode;
  private network: NetworkController;
  private presentation: SessionPresentation;
  private task: TaskUiController;
  private permissions: PermissionController;
  // Messages submitted while a turn was in flight; sent FIFO, one per turn,
  // when the agent returns to idle.
  private queuedMessages: string[] = [];
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
  private permissionStore: PermissionStore;
  private registry = buildRegistry();
  private skills: Skill[] = [];
  private fileIndex: FileIndex;
  private availableModels: string[] = [];
  private mcpServers: Record<string, Record<string, unknown>> = {};
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
      onError: text => this.buffer.append({ kind: "error", text }),
      onQueueEmpty: () => { this.phase = "streaming"; },
      recompute: () => this.recompute()
    });
    this.keys = new KeyRouter(this.keyRouterHost());
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
    if (this.phase !== "idle" || this.queuedMessages.length === 0) return;
    const next = this.queuedMessages.shift();
    if (next !== undefined) this.handleSubmit(next);
  }

  private refreshSkills(): void {
    this.skills = loadSkills(this.props.cwd);
    this.registry = mergeSkillCommands(buildRegistry(), this.skills);
  }

  private createSession(name: string, resume?: string, modeOverride?: PermissionMode): AgentSession {
    this.availableModels = [];
    this.mcpServers = loadMcpServers(this.props.cwd, undefined, this.allowProjectConfig);
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
      mcpServers: this.mcpServers,
      lspRegistry: loadRegistry(undefined, join(this.props.cwd, ".cloudcode", "lsp.json"), this.allowProjectConfig),
      onMessage: msg => this.handleMessage(msg),
      onPermissionRequest: req => {
        this.phase = "permission";
        this.permissions.enqueue(req);
      },
      onSessionId: id => { this.task.sessionStarted(id); if (this.firstMessage) this.recordSession(id, name); }
    });
    session.start();
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
        return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir ?? `'${r.prefix}' commands`}`).join("\n");
      },
      clearPermissionRules: () => this.permissionStore.clear(),
      mcpStatus: async () =>
        formatMcpStatus(Object.keys(this.mcpServers), (await this.session?.mcpStatus()) ?? [], this.session?.tools ?? []),
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
    this.buffer.append({ kind: "user", text });
    this.phase = "streaming";
    this.workStartedAt = Date.now();
    this.session?.send(text);
    this.recompute();
  }

  private handleSubmit(text: string): void {
    if (this.phase === "streaming") {
      // The agent is mid-turn: queue the message and send it when idle.
      // Slash parsing happens at dequeue time so queued commands run in order.
      this.queuedMessages.push(text);
      this.recompute();
      return;
    }
    const slash = parseSlash(text);
    if (slash) {
      const cmd = this.registry.get(slash.name);
      if (!cmd) {
        this.notice(`Unknown command: /${slash.name}`);
        this.recompute();
        // Slash commands never start a model turn, so nothing else will
        // drain the queue -- drain it here to avoid stalling behind an
        // unknown command.
        this.drainQueueIfIdle();
        return;
      }
      cmd.run(this.ctx, slash.args)
        .catch(err => {
          this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        })
        // Async commands (e.g. /mcp) append output after the submit-time
        // repaint, so repaint again once the command settles.
        .finally(() => {
          // /exit (and double-Ctrl+C's ctx.exit()) call stop() synchronously
          // inside run(), which already finalized and cleared the terminal.
          // Without this guard, this callback still fires on the next
          // microtask and repaints a brand-new frame (fresh empty prompt,
          // fresh elapsed timer) over what should be a torn-down screen.
          if (!this.running) return;
          this.recompute();
          // Slash commands never start a model turn (no "result" message),
          // so drain the queue here or a queued item after a slash command
          // would stall indefinitely.
          this.drainQueueIfIdle();
        });
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

  private resizeRepaintTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Any resize leaves debris that no in-place footer repaint can fix. On a
   * width change the terminal reflows the transcript rows that were
   * committed to scrollback at the old width, garbling history. On a height
   * shrink the host pushes the viewport top -- including previously painted
   * footer rows -- into scrollback, baking stale footer copies there, where
   * no escape sequence can reach them. The only correct recovery for both
   * is a scrollback-clearing reprint of the whole transcript at the settled
   * size. Resize events arrive in storms while the user drags the window
   * edge, so the expensive full repaint is debounced until the size
   * settles; each in-storm frame is still repainted immediately so the
   * footer tracks the live size.
   */
  private handleResize(): void {
    // A stopped App must be fully inert: without this guard, an instance
    // whose resize callback outlives stop() (e.g. across a project switch)
    // keeps repainting on every resize with its stale, empty renderer state,
    // clearing the screen and stamping an outdated footer over the live
    // App's frames.
    if (!this.running) return;
    this.recompute();
    if (this.resizeRepaintTimer) clearTimeout(this.resizeRepaintTimer);
    this.resizeRepaintTimer = setTimeout(() => {
      this.resizeRepaintTimer = undefined;
      if (!this.running) return;
      this.terminal.write(CLEAR_ALL_AND_HOME);
      this.renderer.invalidate();
      this.buffer.recommitAll();
      this.recompute();
    }, 150);
  }

  tick(): void {
    if (this.phase === "idle" && this.usage.compactPct === undefined) return;
    this.workIndFrame += 1;
    this.recompute();
  }

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
      handleInputKey: k => this.inputBox.handleKey(k),
      recompute: () => this.recompute()
    };
  }

  handleKeys(ks: Key[]): void {
    this.keys.handleKeys(ks);
  }

  handleKey(k: Key): void {
    this.keys.handleKey(k);
  }

  recompute(): void {
    const size = this.terminal.size();
    const inputVisible = this.overlay.mode === "none" && this.phase !== "permission";
    const queueCode = sgr(this.theme.muted);
    const queuedRows = this.queuedMessages.map(m => {
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
        elapsedMs: Date.now() - this.startedAt
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
    this.terminal.onResize(() => this.handleResize());
    this.terminal.onKeys(keys => this.handleKeys(keys));
    this.terminal.onLine(line => this.handleSubmit(line));
    const trust = this.resolveProjectConfigTrust();
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
  private resolveProjectConfigTrust(): boolean | Promise<boolean> {
    const descriptor = inspectProjectExecutableConfig(this.props.cwd);
    if (!descriptor) return true;
    const store = new ProjectTrustStore();
    if (store.isTrusted(descriptor)) return true;
    return new Promise(resolve => {
      this.overlay.openTrust(descriptor.projectPath, descriptor.commands, allow => {
        if (allow) {
          try { store.approve(descriptor); }
          catch (err) { this.buffer.append({ kind: "error", text: `Failed to save project trust: ${err instanceof Error ? err.message : String(err)}` }); }
        } else {
          this.notice("Ignored untrusted project MCP/LSP configuration.");
        }
        resolve(allow);
      });
      this.recompute();
    });
  }
  private stopResolve: (() => void) | undefined;
  private stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.resizeRepaintTimer) clearTimeout(this.resizeRepaintTimer);
    this.git.stop();
    this.terminal.write(this.renderer.finalize());
    this.running = false;
    this.stopResolve?.();
  }
}
