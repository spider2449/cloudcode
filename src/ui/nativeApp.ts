import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, type DisplayItem } from "./transcript.js";
import { fetchModels } from "../agent/models.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { loadWelcome } from "./welcome.js";
import { VERSION } from "../version.js";
import { recentProjects, resolveProjectPath } from "../commands/projectPath.js";
import { GitStatusPoller } from "./useGitStatus.js";
import { Buffer } from "./buffer.js";
import { InputBox } from "./widgets/inputBox.js";
import { OverlayManager } from "./widgets/overlay.js";
import { render, type BottomState } from "./term/render.js";
import type { ITerminal } from "./term/terminal.js";
import type { Key } from "./input.js";

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
const CONTEXT_WINDOW = 200_000;
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
  private activeTool: string | undefined;
  private providerName: string;
  private model: string | undefined;
  private servedModel: string | undefined;
  private mode: PermissionMode;
  private permissionQueue: PermissionRequest[] = [];
  private cost = 0;
  private tokens = 0;
  private contextPct: number | undefined;
  private compactPct: number | undefined;
  private turnCount = 0;
  private startedAt = Date.now();
  private workStartedAt = 0;
  private workIndFrame = 0;
  private scrollOffset: number | null = null;
  private welcomePinned = false;
  // Item count at construction; the welcome pin auto-releases once the
  // transcript grows past this, so anything appended later (chat, slash
  // command output, errors) scrolls into view instead of landing below a
  // still-pinned banner.
  private startupItemCount = 0;

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

    this.startupItemCount = this.buffer.itemCount;

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
      this.buffer.append({ kind: "notice", text: welcome });
      // Pin the view (not scrollOffset itself, so the "Press End" hint stays hidden)
      // to the top so the banner is fully visible instead of tail-anchored past its end.
      this.welcomePinned = true;
    }
  }

  private modelFor(name: string): string | undefined {
    return (name === this.props.initialProvider ? this.props.initialModel : undefined) ?? this.props.providers[name]?.model;
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
        this.contextPct = Math.min(100, Math.round((estimatedTokens / CONTEXT_WINDOW) * 100));
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
    const delta = streamDelta(msg);
    if (delta) { this.streamText += delta; this.recompute(); return; }
    const mapped = toDisplayItems(msg);
    for (const item of mapped) this.buffer.append(item);
    if (mapped.some(i => i.kind === "assistant")) { this.streamText = ""; this.activeTool = undefined; }
    const lastTool = [...mapped].reverse().find((i): i is Extract<DisplayItem, { kind: "tool" }> => i.kind === "tool");
    if (lastTool) this.activeTool = lastTool.label.split(" ")[0];

    const t = (msg as { type: string }).type;
    if (t === "result") {
      if (this.streamText) {
        this.buffer.append({ kind: "assistant", text: this.streamText });
        this.streamText = "";
      }
      this.activeTool = undefined;
      this.phase = "idle";
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") this.cost += cost;
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        this.tokens += input + output;
        const pct = Math.min(100, Math.round((input / CONTEXT_WINDOW) * 100));
        this.contextPct = pct;
        if (pct >= AUTO_COMPACT_THRESHOLD_PCT) void this.runAutoCompact();
      }
      this.turnCount += 1;
      void this.git.refresh().then(() => this.recompute());
    }
    this.recompute();
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
    if (rememberAs && active && typeof active.input.file_path === "string") {
      try {
        this.permissionStore.remember(active.toolName, active.input.file_path, rememberAs);
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
        this.streamText = "";
        this.activeTool = undefined;
        this.scrollOffset = null;
        this.appendWelcome();
        this.startupItemCount = this.buffer.itemCount;
        await this.restartSession(this.providerName);
        this.recompute();
      },
      setModel: async m => { await this.session?.setModel(m); this.model = m; this.servedModel = undefined; this.recompute(); },
      availableModels: () => this.availableModels,
      currentModel: () => this.model,
      setPermissionMode: async m => {
        const pm = m as PermissionMode;
        await this.session?.setPermissionMode(pm);
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
        if (typeof estimatedTokens === "number") this.contextPct = Math.min(100, Math.round((estimatedTokens / CONTEXT_WINDOW) * 100));
        return estimatedTokens;
      },
      setCompactProgress: pct => { this.compactPct = pct; this.recompute(); },
      openResumePicker: () => {
        this.overlay.openResume(this.props.sessionIndex.list(), e => this.pickResume(e), () => { this.overlay.close(); this.recompute(); });
        this.recompute();
      },
      costSummary: () => `Session cost: $${this.cost.toFixed(4)}`,
      providerNames: () => Object.keys(this.props.providers),
      exit: () => { void this.session?.dispose(); this.stop(); },
      listPermissionRules: () => {
        const rules = this.permissionStore.list();
        if (rules.length === 0) return "No permission rules.";
        return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir}`).join("\n");
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
        if (err) this.notice(err);
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
    if (this.phase === "streaming") return;
    const slash = parseSlash(text);
    if (slash) {
      const cmd = this.registry.get(slash.name);
      if (!cmd) { this.notice(`Unknown command: /${slash.name}`); this.recompute(); return; }
      cmd.run(this.ctx, slash.args).catch(err => {
        this.buffer.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        this.recompute();
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

  tick(): void {
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

    // Phase 2: scrollback navigation, only when no overlay is open.
    if (this.overlay.mode === "none") {
      const size = this.terminal.size();
      const height = Math.max(1, size.rows - 6);
      if (k.t === "pgup" || (k.t === "ctrl" && k.ch === "b")) {
        const total = this.buffer.totalRows(size.columns, this.theme);
        const current = this.scrollOffset ?? (this.welcomePinned ? 0 : Math.max(0, total - height));
        this.welcomePinned = false;
        this.scrollOffset = Math.max(0, current - height);
        this.recompute();
        return;
      }
      if (k.t === "pgdn" || (k.t === "ctrl" && k.ch === "f")) {
        const total = this.buffer.totalRows(size.columns, this.theme);
        const current = this.scrollOffset ?? (this.welcomePinned ? 0 : Math.max(0, total - height));
        const next = current + height;
        this.welcomePinned = false;
        this.scrollOffset = next >= total - height ? null : next;
        this.recompute();
        return;
      }
      if (k.t === "home") { this.welcomePinned = false; this.scrollOffset = 0; this.recompute(); return; }
      if (k.t === "end") { this.welcomePinned = false; this.scrollOffset = null; this.recompute(); return; }
      if (k.t === "wheel") {
        const total = this.buffer.totalRows(size.columns, this.theme);
        const current = this.scrollOffset ?? (this.welcomePinned ? 0 : Math.max(0, total - height));
        this.welcomePinned = false;
        if (k.dir === "up") {
          this.scrollOffset = Math.max(0, current - 3);
        } else {
          const next = current + 3;
          this.scrollOffset = next >= total - height ? null : next;
        }
        this.recompute();
        return;
      }
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
      this.inputBox.handlePaste(k.text, this.phase === "streaming");
      this.recompute();
      return;
    }
    this.inputBox.handleKey(k, this.phase === "streaming");
    this.recompute();
  }

  recompute(): void {
    const size = this.terminal.size();
    if (this.welcomePinned && this.buffer.itemCount > this.startupItemCount) this.welcomePinned = false;
    const inputVisible = this.overlay.mode === "none" && this.phase !== "permission";
    const bottom: BottomState = {
      overlay: this.overlay.mode,
      streaming: this.phase === "streaming",
      streamingText: this.streamText,
      activeTool: this.activeTool,
      compactPct: this.compactPct,
      scrollOffset: this.scrollOffset,
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
    const viewOffset = this.scrollOffset ?? (this.welcomePinned ? 0 : null);
    const frame = render(this.buffer, this.scrollOffset, bottom, this.theme, size, viewOffset);
    this.terminal.write(frame);
  }

  async run(): Promise<void> {
    this.running = true;
    this.session = this.createSession(this.props.initialProvider, this.props.resume);
    this.git.start();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.terminal.onResize(() => this.recompute());
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
    this.git.stop();
    this.running = false;
    this.stopResolve?.();
  }
}
