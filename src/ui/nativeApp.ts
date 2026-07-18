import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import { History } from "../agent/history.js";
import { DEFAULT_CONTEXT_WINDOW, type ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore, commandPrefix } from "../agent/permissionStore.js";
import { buildRegistry } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, streamThinkingDelta, type DisplayItem } from "./transcript.js";
import { fetchModels } from "../agent/models.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { loadWelcome, splitWelcomeLogo } from "./welcome.js";
import { VERSION } from "../version.js";
import { recentProjects, resolveProjectPath } from "../commands/projectPath.js";
import { GitStatusPoller } from "./useGitStatus.js";
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
import { buildMemoryOptions } from "./MemoryPicker.js";
import { openInEditor, openFolder } from "../commands/editor.js";
import { ensureMemoryDir } from "../engine/memoryPaths.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  initialModel?: string;
  initialMode?: PermissionMode;
  resume?: string;
  sessionIndex: SessionIndex;
  openResumeOnStart?: boolean;
  onSwitchProject?: (path: string) => string | undefined;
  switchedFrom?: string;
}

type Phase = "idle" | "streaming" | "permission";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
const AUTO_COMPACT_THRESHOLD_PCT = 80;

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
  private permissionQueue: PermissionRequest[] = [];
  // Messages submitted while a turn was in flight; sent FIFO, one per turn,
  // when the agent returns to idle.
  private queuedMessages: string[] = [];
  private cost = 0;
  private tokens = 0;
  private contextPct: number | undefined;
  private compactPct: number | undefined;
  private turnCount = 0;
  private startedAt = Date.now();
  private workStartedAt = 0;
  private workIndFrame = 0;
  private renderer = new InlineRenderer();

  private firstMessage: string | undefined;
  private session: AgentSession | undefined;
  private lastCtrlCAt = 0;
  private history = new History();
  private permissionStore: PermissionStore;
  private registry = buildRegistry();
  private skills: Skill[] = [];
  private fileIndex: FileIndex;
  private availableModels: string[] = [];
  private mcpServers: Record<string, Record<string, unknown>> = {};
  private autoCompacting = false;
  private git: GitStatusPoller;
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  private ctx: CommandContext;
  private completionCtx: CompletionContext;

  constructor(private props: AppProps, private terminal: ITerminal) {
    this.providerName = props.initialProvider;
    this.model = this.modelFor(props.initialProvider);
    this.mode = props.initialMode ?? "default";
    this.permissionStore = new PermissionStore(props.cwd);
    this.fileIndex = new FileIndex(props.cwd);
    this.git = new GitStatusPoller(props.cwd);
    this.completionCtx = this.completionCtxRef();
    this.inputBox = new InputBox(this.completionCtx, this.history);
    this.inputBox.onSubmit = text => this.handleSubmit(text);
    this.ctx = this.buildCommandContext();

    this.appendWelcome();
    if (props.switchedFrom) this.buffer.append({ kind: "notice", text: `Switched project to ${props.cwd}` });

    if (props.openResumeOnStart) {
      this.overlay.openResume(
        props.sessionIndex.list(),
        e => this.pickResume(e),
        () => this.overlay.close()
      );
    }
  }

  /** Append the welcome banner to the buffer and pin the view to its top. */
  private appendWelcome(): void {
    const size = this.terminal.size();
    const welcome = loadWelcome(
      { version: VERSION, provider: this.providerName, model: this.model },
      undefined,
      { rows: Math.max(1, size.rows - 6), columns: size.columns }
    );
    if (welcome) {
      const { logo, body } = splitWelcomeLogo(welcome);
      this.buffer.append(logo !== undefined ? { kind: "welcome", logo, body } : { kind: "notice", text: body });
    }
  }

  private modelFor(name: string): string | undefined {
    return (name === this.props.initialProvider ? this.props.initialModel : undefined) ?? this.props.providers[name]?.model;
  }

  private contextWindowFor(name: string): number {
    return this.props.providers[name]?.model_context_window ?? DEFAULT_CONTEXT_WINDOW;
  }

  private completionCtxRef(): CompletionContext {
    return {
      registry: this.registry,
      providerNames: () => Object.keys(this.props.providers),
      availableModels: () => this.availableModels,
      listFiles: () => this.fileIndex.list(),
      refreshFiles: () => this.fileIndex.refresh()
    };
  }

  private notice(text: string): void {
    this.buffer.append({ kind: "notice", text });
  }

  private async runAutoCompact(): Promise<void> {
    if (this.autoCompacting) return;
    this.autoCompacting = true;
    this.onAutoCompactForTest?.();
    this.compactPct = 0;
    this.recompute();
    try {
      const estimatedTokens = await this.session?.compact(pct => { this.compactPct = pct; this.recompute(); });
      if (typeof estimatedTokens === "number") {
        this.tokens = estimatedTokens;
        this.contextPct = Math.min(100, Math.round((estimatedTokens / this.contextWindowFor(this.providerName)) * 100));
      }
      this.notice("Context was getting full — compacted automatically.");
    } catch (err) {
      this.buffer.append({ kind: "error", text: `Auto-compact failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      this.compactPct = undefined;
      this.autoCompacting = false;
      this.recompute();
    }
  }

  handleMessage(msg: EngineMessage): void {
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
      this.phase = "idle";
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") this.cost += cost;
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        // Current context size, not a running lifetime sum: `input` already
        // covers the whole resent history, so summing it turn over turn would
        // double-count and drift away from what /context reports.
        this.tokens = input + output;
        const pct = Math.min(100, Math.round((input / this.contextWindowFor(this.providerName)) * 100));
        this.contextPct = pct;
        if (pct >= AUTO_COMPACT_THRESHOLD_PCT) void this.runAutoCompact();
      }
      this.turnCount += 1;
      void this.git.refresh().then(() => this.recompute());
      this.drainQueueIfIdle();
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
    void fetchModels(this.props.providers[name] ?? {}).then(models => { this.availableModels = models; });
    this.mcpServers = loadMcpServers(this.props.cwd);
    this.refreshSkills();
    const session = new AgentSession({
      providerName: name,
      provider: this.props.providers[name],
      model: this.modelFor(name),
      effort: this.effort,
      permissionMode: modeOverride ?? this.mode,
      resume,
      cwd: this.props.cwd,
      mcpServers: this.mcpServers,
      onMessage: msg => this.handleMessage(msg),
      onPermissionRequest: req => {
        this.permissionQueue.push(req);
        this.phase = "permission";
        this.openNextPermission();
      },
      onSessionId: id => { if (this.firstMessage) this.recordSession(id, name); }
    });
    session.start();
    return session;
  }

  private openNextPermission(): void {
    const active = this.permissionQueue[0];
    if (!active) return;
    this.overlay.openPermission(active, (allow, rememberAs) => this.decidePermission(allow, rememberAs));
    this.recompute();
  }

  private decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
    const active = this.permissionQueue[0];
    if (rememberAs && active) {
      try {
        if (typeof active.input.file_path === "string") {
          this.permissionStore.remember(active.toolName, active.input.file_path, rememberAs);
        } else if (active.toolName === "Bash" && typeof active.input.command === "string") {
          this.permissionStore.rememberCommand(commandPrefix(String(active.input.command)), rememberAs);
        }
      } catch (err) {
        this.buffer.append({ kind: "error", text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    active?.resolve(allow);
    this.permissionQueue = this.permissionQueue.slice(1);
    if (this.permissionQueue.length === 0) this.phase = "streaming";
    else this.openNextPermission();
    this.recompute();
  }

  private recordSession(id: string, provider: string): void {
    this.props.sessionIndex.record({
      id, cwd: this.props.cwd, firstMessage: this.firstMessage ?? "", timestamp: new Date().toISOString(), provider
    });
  }

  private async restartSession(name: string, resume?: string, modeOverride?: PermissionMode): Promise<void> {
    await this.session?.dispose();
    this.firstMessage = undefined;
    this.session = this.createSession(name, resume, modeOverride);
    this.model = this.modelFor(name);
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
      switchProvider: async name => {
        if (!this.props.providers[name]) {
          this.notice(`Unknown provider: ${name}. Providers: ${Object.keys(this.props.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
          return;
        }
        const previous = this.providerName;
        try {
          await this.restartSession(name);
          this.providerName = name;
          this.model = this.modelFor(name);
          this.notice(`Provider: ${name}`);
        } catch (err) {
          this.notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
          await this.restartSession(previous);
        }
        this.recompute();
      },
      compact: async onProgress => {
        const estimatedTokens = await this.session?.compact(onProgress);
        if (typeof estimatedTokens === "number") {
          this.tokens = estimatedTokens;
          this.contextPct = Math.min(100, Math.round((estimatedTokens / this.contextWindowFor(this.providerName)) * 100));
        }
        return estimatedTokens;
      },
      setCompactProgress: pct => { this.compactPct = pct; this.recompute(); },
      openResumePicker: () => {
        this.overlay.openResume(this.props.sessionIndex.listForCwd(this.props.cwd), e => this.pickResume(e), () => { this.overlay.close(); this.recompute(); });
        this.recompute();
      },
      costSummary: () => `Session cost: $${this.cost.toFixed(4)}`,
      contextInfo: () => ({
        snapshot: this.session?.contextSnapshot(),
        model: this.modelFor(this.providerName) ?? "unknown",
        contextWindow: this.contextWindowFor(this.providerName)
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
      openProjectPicker: () => {
        this.overlay.openProject(
          recentProjects(this.props.sessionIndex.list(), this.props.cwd),
          this.props.cwd,
          p => {
            const result = resolveProjectPath(p, this.props.cwd);
            if (!result.ok) { this.notice(result.error); return; }
            this.ctx.switchProject(result.path);
          },
          () => { this.overlay.close(); this.recompute(); }
        );
        this.recompute();
      },
      openMemoryPicker: () => {
        this.overlay.openMemory(
          buildMemoryOptions(this.props.cwd),
          o => {
            if (o.kind === "folder") {
              ensureMemoryDir(o.path);
              openFolder(o.path);
              this.notice(`Opened ${o.path}`);
              return;
            }
            const r = openInEditor(o.path);
            this.notice(r.hint);
            if (r.ok) void this.session?.refreshSystemPrompt();
          },
          () => { this.overlay.close(); this.recompute(); }
        );
        this.recompute();
      },
      currentCwd: () => this.props.cwd
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
    if (this.phase === "idle" && this.compactPct === undefined) return;
    this.workIndFrame += 1;
    this.recompute();
  }

  handleKeys(ks: Key[]): void {
    for (const k of ks) this.handleKey(k);
  }

  handleKey(k: Key): void {
    // Phase 1: globals.
    if (k.t === "esc" && this.phase === "streaming" && this.overlay.mode === "none") {
      void this.session?.interrupt();
      return;
    }
    if (k.t === "ctrl" && k.ch === "l") {
      this.terminal.write(CLEAR_AND_HOME);
      this.renderer.invalidate();
      this.recompute();
      return;
    }
    if (k.t === "ctrl" && k.ch === "c") {
      const now = Date.now();
      if (now - this.lastCtrlCAt < 2000) {
        this.ctx.exit();
      } else {
        this.lastCtrlCAt = now;
        void this.session?.interrupt();
        this.notice("Press Ctrl+C again to exit.");
        this.recompute();
      }
      return;
    }

    // Phase 3: focus owner.
    if (this.overlay.isOpen) {
      const input = k.t === "printable" ? k.ch : undefined;
      this.overlay.handleKey(k, input);
      this.recompute();
      return;
    }
    if (k.t === "backtab") {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(this.mode) + 1) % MODE_CYCLE.length];
      this.ctx.setPermissionMode(next).catch(err => {
        this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        this.recompute();
      });
      return;
    }
    if (k.t === "paste") {
      this.inputBox.handlePaste(k.text);
      this.recompute();
      return;
    }
    this.inputBox.handleKey(k);
    this.recompute();
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
      compactPct: this.compactPct,
      queuedRows,
      inputRender: inputVisible
        ? this.inputBox.render(this.theme, size.columns, this.phase === "streaming")
        : { borderRows: [], contentRows: [], menuRows: [], hintRow: null, totalRows: 0 },
      overlayRows: this.overlay.isOpen ? this.overlay.render(this.theme, size.columns) : [],
      statusBarProps: {
        provider: this.providerName,
        model: this.model,
        servedModel: this.servedModel,
        mode: this.mode,
        cwd: this.props.cwd,
        costUsd: this.cost,
        gitBranch: this.git.status.branch,
        gitDirty: this.git.status.dirty,
        tokens: this.tokens,
        contextPct: this.contextPct,
        elapsedMs: Date.now() - this.startedAt
      },
      workIndFrame: this.workIndFrame,
      workStartedAt: this.workStartedAt
    };
    this.terminal.write(this.renderer.frame(this.buffer, bottom, this.theme, size));
  }

  async run(): Promise<void> {
    this.running = true;
    this.session = this.createSession(this.props.initialProvider, this.props.resume);
    this.git.start();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.terminal.onResize(() => this.handleResize());
    this.terminal.onKeys(keys => this.handleKeys(keys));
    this.terminal.onLine(line => this.handleSubmit(line));
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
    if (this.resizeRepaintTimer) clearTimeout(this.resizeRepaintTimer);
    this.git.stop();
    this.terminal.write(this.renderer.finalize());
    this.running = false;
    this.stopResolve?.();
  }
}
