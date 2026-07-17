import React, { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { EngineMessage } from "../engine/messages.js";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry, } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, streamThinkingDelta, type DisplayItem } from "./transcript.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { StatusBar } from "./StatusBar.js";
import { fetchModels } from "../agent/models.js";
import { ResumePicker } from "./ResumePicker.js";
import { MemoryPicker, buildMemoryOptions } from "./MemoryPicker.js";
import { openInEditor, openFolder } from "../commands/editor.js";
import { ensureMemoryDir } from "../engine/memoryPaths.js";
import { WorkingIndicator } from "./WorkingIndicator.js";
import { ProgressBar } from "./ProgressBar.js";
import { useGitStatus } from "./useGitStatus.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { THEMES, loadThemeName, saveThemeName } from "./theme.js";
import { saveSetting } from "../agent/settings.js";
import { ThemeProvider } from "./ThemeContext.js";
import { loadWelcome, splitWelcomeLogo } from "./welcome.js";
import { tailForHeight } from "./streamTail.js";
import { VERSION } from "../version.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { recentProjects, resolveProjectPath } from "../commands/projectPath.js";
import { staticRows, resizeSafeFillerHeight, liveRegionFloor, textRows, itemRows } from "./bottomFill.js";
import { loadSettings } from "../agent/settings.js";
import type { EffortLevel } from "../engine/effort.js";

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
const DEFAULT_CONTEXT_WINDOW = 200_000;
const AUTO_COMPACT_THRESHOLD_PCT = 80;

export function App(props: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  function modelFor(name: string): string | undefined {
    return (name === props.initialProvider ? props.initialModel : undefined) ?? props.providers[name]?.model;
  }
  function contextWindowFor(name: string): number {
    return props.providers[name]?.model_context_window ?? DEFAULT_CONTEXT_WINDOW;
  }
  function welcomeItems(provider: string): DisplayItem[] {
    // Fit budget: terminal minus the live region floor (input box 3 + status
    // bar 1 + working-indicator/hint headroom 2). A banner taller than this
    // pushes the transcript's top rows above the visible screen, since the
    // <Static> transcript scrolls rather than clips.
    const welcome = loadWelcome(
      {
        version: VERSION,
        provider,
        model: modelFor(provider)
      },
      undefined,
      {
        rows: Math.max(1, (process.stdout.rows ?? 24) - 6),
        columns: process.stdout.columns ?? 80
      }
    );
    if (!welcome) return [];
    const { logo, body } = splitWelcomeLogo(welcome);
    return logo !== undefined ? [{ kind: "welcome", logo, body }] : [{ kind: "notice", text: body }];
  }
  const [items, setItems] = useState<DisplayItem[]>(() => {
    const initial = welcomeItems(props.initialProvider);
    if (props.switchedFrom) initial.push({ kind: "notice", text: `Switched project to ${props.cwd}` });
    return initial;
  });
  // phase/streamText/activeTool are grouped into one state object and patched
  // via a single setState call per event: Ink's root runs in legacy React
  // mode (see ink/build/instance.js), so state updates from async callbacks
  // (like handleMessage below, driven by the agent session rather than an
  // Ink input event) are NOT auto-batched - each separate setState call
  // forces its own synchronous re-render of the live region. When a turn
  // finishes, these three fields all shrink the live region's height at
  // once; rendering that as several separate frames (rather than one) is
  // what produces the transient ghost/misplaced frames right as a response
  // completes.
  type LiveState = { phase: Phase; streamText: string; activeTool?: string; thinkingText: string };
  const [live, setLive] = useState<LiveState>({ phase: "idle", streamText: "", activeTool: undefined, thinkingText: "" });
  const { phase, streamText, activeTool, thinkingText } = live;
  const patchLive = (patch: Partial<LiveState>) => setLive(prev => ({ ...prev, ...patch }));
  // Remount key for the <Static> transcript; bump whenever items are reset.
  const [transcriptKey, setTranscriptKey] = useState(0);
  const resetItems = () => { setItems([]); setTranscriptKey(k => k + 1); };
  const [providerName, setProviderName] = useState(props.initialProvider);
  const [model, setModel] = useState<string | undefined>(modelFor(props.initialProvider));
  const effortRef = useRef<EffortLevel>(loadSettings().effort ?? "off");
  const [mode, setMode] = useState<PermissionMode>(props.initialMode ?? "default");
  const [servedModel, setServedModel] = useState<string | undefined>(undefined);
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [showResumePicker, setShowResumePicker] = useState(props.openResumeOnStart ?? false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showMemoryPicker, setShowMemoryPicker] = useState(false);
  const [cost, setCost] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [compactPct, setCompactPct] = useState<number | undefined>(undefined);
  const [turnCount, setTurnCount] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamRef = useRef("");
  const thinkingRef = useRef("");
  const [workStartedAt, setWorkStartedAt] = useState(0);
  const liveRegionRef = useRef<DOMElement>(null);
  const [dynamicRows, setDynamicRows] = useState(0);
  // Exact row count of InputBox's currently open suggestion menu, reported
  // synchronously from within the same input-event batch that updates
  // InputBox's own state (see InputBox's onMenuRowsChange doc comment) so
  // the live-region floor never has to guess/reserve a fixed worst case.
  const [menuRows, setMenuRows] = useState(0);
  // Exact rendered row count of InputBox's own bordered box (border +
  // wrapped value), reported same-batch via InputBox's onInputRowsChange —
  // see bottomFill.ts's inputBoxRows doc comment. Defaults to 3 (2 border +
  // 1 line), the correct value for an empty input, so there is no
  // window before InputBox's first report where this is wrong.
  const [inputRows, setInputRows] = useState(3);
  const [termSize, setTermSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  // Set alongside termSize whenever a resize fires; read-and-cleared once at
  // the filler computation site below. See resizeSafeFillerHeight's doc
  // comment in bottomFill.ts: for one render right after a resize, the
  // measured/floor values feeding the filler calc still lag the OLD
  // terminal width, so that one frame forces filler=0 instead of trusting
  // the stale values.
  const justResizedRef = useRef(false);
  // Bottom-anchoring state for when the transcript has outgrown the screen
  // (base filler 0): the previous frame's total row count and how many items
  // were already committed to <Static>, so a frame whose live region SHRANK
  // (e.g. a tall stream tail just committed on "result") can pad itself to
  // keep its bottom edge in place instead of leaving the footer stranded
  // mid-screen above the rows the taller frame used to occupy.
  const prevFrameRowsRef = useRef(0);
  const prevStaticCountRef = useRef(0);
  const prevTranscriptKeyRef = useRef(0);
  const firstMessageRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<AgentSession | null>(null);
  const lastCtrlCRef = useRef(0);
  const historyRef = useRef(new History());
  const permissionStoreRef = useRef(new PermissionStore(props.cwd));
  const [registry, setRegistry] = useState(() => buildRegistry());
  const [themeName, setThemeName] = useState(() => loadThemeName());
  const skillsRef = useRef<Skill[]>([]);
  const fileIndexRef = useRef(new FileIndex(props.cwd));
  const availableModelsRef = useRef<string[]>([]);
  const mcpServersRef = useRef<Record<string, Record<string, unknown>>>({});
  const completionCtx: CompletionContext = {
    registry,
    providerNames: () => Object.keys(props.providers),
    availableModels: () => availableModelsRef.current,
    listFiles: () => fileIndexRef.current.list(),
    refreshFiles: () => fileIndexRef.current.refresh()
  };

  const notice = (text: string) => setItems(prev => [...prev, { kind: "notice", text }]);
  const setStream = (text: string) => { streamRef.current = text; patchLive({ streamText: text }); };
  const autoCompactingRef = useRef(false);

  async function runAutoCompact(): Promise<void> {
    if (autoCompactingRef.current) return;
    autoCompactingRef.current = true;
    setCompactPct(0);
    try {
      const estimatedTokens = await sessionRef.current?.compact(pct => setCompactPct(pct));
      if (typeof estimatedTokens === "number") {
        setContextPct(Math.min(100, Math.round((estimatedTokens / contextWindowFor(providerName)) * 100)));
      }
      notice("Context was getting full — compacted automatically.");
    } catch (err) {
      setItems(prev => [...prev, {
        kind: "error",
        text: `Auto-compact failed: ${err instanceof Error ? err.message : String(err)}`
      }]);
    } finally {
      setCompactPct(undefined);
      autoCompactingRef.current = false;
    }
  }

  function handleMessage(msg: EngineMessage): void {
    const served = (msg as { message?: { model?: string } }).message?.model;
    if (served) setServedModel(served);
    const thinking = streamThinkingDelta(msg);
    if (thinking) { thinkingRef.current += thinking; patchLive({ thinkingText: thinkingRef.current }); return; }
    const delta = streamDelta(msg);
    if (delta) {
      thinkingRef.current = "";
      streamRef.current = streamRef.current + delta;
      patchLive({ streamText: streamRef.current, thinkingText: "" });
      return;
    }
    const mapped = toDisplayItems(msg);
    if (mapped.length > 0) setItems(prev => [...prev, ...mapped]);
    const patch: Partial<LiveState> = {};
    if (mapped.some(i => i.kind === "assistant")) { streamRef.current = ""; thinkingRef.current = ""; patch.streamText = ""; patch.thinkingText = ""; patch.activeTool = undefined; }
    const lastTool = [...mapped].reverse().find(i => i.kind === "tool");
    if (lastTool && lastTool.kind === "tool") patch.activeTool = lastTool.label.split(" ")[0];
    const t = (msg as { type: string }).type;
    if (t === "result") {
      if (streamRef.current) {
        const text = streamRef.current;
        setItems(prev => [...prev, { kind: "assistant", text }]);
        streamRef.current = "";
      }
      thinkingRef.current = "";
      patch.streamText = "";
      patch.thinkingText = "";
      patch.activeTool = undefined;
      patch.phase = "idle";
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") setCost(prev => prev + cost);
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        setTokens(prev => prev + input + output);
        const pct = Math.min(100, Math.round((input / contextWindowFor(providerName)) * 100));
        setContextPct(pct);
        if (pct >= AUTO_COMPACT_THRESHOLD_PCT) void runAutoCompact();
      }
      setTurnCount(prev => prev + 1);
    }
    if (Object.keys(patch).length > 0) patchLive(patch);
  }

  function refreshSkills(): void {
    skillsRef.current = loadSkills(props.cwd);
    setRegistry(mergeSkillCommands(buildRegistry(), skillsRef.current));
  }

  function createSession(name: string, resume?: string, modeOverride?: PermissionMode): AgentSession {
    availableModelsRef.current = [];
    void fetchModels(props.providers[name] ?? {}).then(models => {
      availableModelsRef.current = models;
    });
    mcpServersRef.current = loadMcpServers(props.cwd);
    refreshSkills();
    const session = new AgentSession({
      providerName: name,
      provider: props.providers[name],
      model: modelFor(name),
      effort: effortRef.current,
      permissionMode: modeOverride ?? mode,
      resume,
      cwd: props.cwd,
      mcpServers: mcpServersRef.current,
      onMessage: handleMessage,
      onPermissionRequest: req => {
        setPermissionQueue(q => [...q, req]);
        patchLive({ phase: "permission" });
      },
      onSessionId: id => {
        if (firstMessageRef.current) recordSession(id, name);
      },
      onMemorySaved: () => notice("Memory updated.")
    });
    session.start();
    return session;
  }

  function recordSession(id: string, provider: string): void {
    props.sessionIndex.record({
      id,
      cwd: props.cwd,
      firstMessage: firstMessageRef.current ?? "",
      timestamp: new Date().toISOString(),
      provider
    });
  }

  useEffect(() => {
    sessionRef.current = createSession(props.initialProvider, props.resume);
    return () => { void sessionRef.current?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setTermSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
      // See resize-transition safety net comment at justResizedRef's
      // declaration and at the filler computation site below.
      justResizedRef.current = true;
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Re-measure the live region after every render; only write state when the
  // height actually changed so this cannot loop.
  useEffect(() => {
    if (!liveRegionRef.current) return;
    const { height } = measureElement(liveRegionRef.current);
    setDynamicRows(prev => (prev === height ? prev : height));
  });

  const git = useGitStatus(props.cwd, turnCount);

  async function restartSession(name: string, resume?: string, modeOverride?: PermissionMode): Promise<void> {
    await sessionRef.current?.dispose();
    firstMessageRef.current = undefined;
    sessionRef.current = createSession(name, resume, modeOverride);
    setModel(modelFor(name));
    setServedModel(undefined);
  }

  const ctx: CommandContext = {
    notice,
    clearSession: async () => {
      setItems(welcomeItems(providerName));
      setTranscriptKey(k => k + 1);
      streamRef.current = "";
      thinkingRef.current = "";
      patchLive({ streamText: "", thinkingText: "", activeTool: undefined });
      await restartSession(providerName);
    },
    setModel: async m => { await sessionRef.current?.setModel(m); setModel(m); setServedModel(undefined); },
    availableModels: () => availableModelsRef.current,
    currentModel: () => model,
    setEffort: async level => { await sessionRef.current?.setEffort(level); effortRef.current = level; },
    currentEffort: () => effortRef.current,
    setPermissionMode: async m => {
      const pm = m as PermissionMode;
      await sessionRef.current?.setPermissionMode(pm);
      if (pm !== "bypassPermissions") saveSetting("permissionMode", pm);
      setMode(pm);
    },
    switchProvider: async name => {
      if (!props.providers[name]) {
        notice(`Unknown provider: ${name}. Providers: ${Object.keys(props.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
        return;
      }
      const previous = providerName;
      try {
        await restartSession(name);
        setProviderName(name);
        setModel(modelFor(name));
        notice(`Provider: ${name}`);
      } catch (err) {
        notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
        await restartSession(previous);
      }
    },
    compact: async (onProgress?: (pct: number) => void) => {
      const estimatedTokens = await sessionRef.current?.compact(onProgress);
      if (typeof estimatedTokens === "number") {
        setContextPct(Math.min(100, Math.round((estimatedTokens / contextWindowFor(providerName)) * 100)));
      }
      return estimatedTokens;
    },
    setCompactProgress: pct => setCompactPct(pct),
    openResumePicker: () => setShowResumePicker(true),
    costSummary: () => `Session cost: $${cost.toFixed(4)}`,
    providerNames: () => Object.keys(props.providers),
    exit: () => { void sessionRef.current?.dispose(); exit(); },
    listPermissionRules: () => {
      const rules = permissionStoreRef.current.list();
      if (rules.length === 0) return "No permission rules.";
      return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir}`).join("\n");
    },
    clearPermissionRules: () => permissionStoreRef.current.clear(),
    mcpStatus: async () =>
      formatMcpStatus(
        Object.keys(mcpServersRef.current),
        (await sessionRef.current?.mcpStatus()) ?? [],
        sessionRef.current?.tools ?? []
      ),
    sendPrompt: text => sendUserMessage(text),
    listSkills: () => formatSkillList(skillsRef.current),
    reloadSkills: () => refreshSkills(),
    setTheme: name => { setThemeName(name); saveThemeName(name); },
    listThemes: () => Object.keys(THEMES).map(n => `${n === themeName ? "●" : " "} ${n}`).join("\n"),
    // Do not dispose the session here: the remount's unmount cleanup
    // (useEffect return) disposes it, and if the switch fails in Root
    // (chdir error) the current session must stay alive.
    switchProject: path => {
      if (!props.onSwitchProject) { notice("Project switching is not available."); return; }
      const err = props.onSwitchProject(path);
      if (err) notice(err);
    },
    openProjectPicker: () => setShowProjectPicker(true),
    currentCwd: () => props.cwd,
    openMemoryPicker: () => setShowMemoryPicker(true),
  };

  function sendUserMessage(text: string): void {
    if (!firstMessageRef.current) {
      firstMessageRef.current = text;
      if (sessionRef.current?.sessionId) recordSession(sessionRef.current.sessionId, providerName);
    }
    setItems(prev => [...prev, { kind: "user", text }]);
    patchLive({ phase: "streaming" });
    setWorkStartedAt(Date.now());
    sessionRef.current?.send(text);
  }

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = registry.get(slash.name);
      if (!cmd) { notice(`Unknown command: /${slash.name}`); return; }
      cmd.run(ctx, slash.args).catch(err => {
        setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      });
      return;
    }
    sendUserMessage(text);
  }

  useInput((_input, key) => {
    if (key.escape && phase === "streaming") void sessionRef.current?.interrupt();
    if (key.tab && key.shift) {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
      ctx.setPermissionMode(next).catch(err => {
        setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      });
    }
    if (key.ctrl && _input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) ctx.exit();
      else { lastCtrlCRef.current = now; void sessionRef.current?.interrupt(); notice("Press Ctrl+C again to exit."); }
    }
  });

  const activePermission = permissionQueue[0];

  function decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
    if (rememberAs && activePermission && typeof activePermission.input.file_path === "string") {
      try {
        permissionStoreRef.current.remember(activePermission.toolName, activePermission.input.file_path, rememberAs);
      } catch (err) {
        setItems(prev => [...prev, {
          kind: "error",
          text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}`
        }]);
      }
    }
    activePermission?.resolve(allow);
    setPermissionQueue(q => {
      const rest = q.slice(1);
      if (rest.length === 0) patchLive({ phase: "streaming" });
      return rest;
    });
  }

  const transcriptRows = staticRows(items, termSize.columns, termSize.rows);

  // Render-time state driving the live region this frame — mirrors the JSX
  // below exactly, so liveRegionFloor is never stale (unlike measureElement,
  // which only reports last frame's height). See bottomFill.ts for why this
  // exists: without it, the frame a live-region element first appears in can
  // overflow the terminal and trigger Ink's scrollback-erasing repaint.
  const inputVisible = !showResumePicker && !showProjectPicker && !showMemoryPicker && phase !== "permission";
  const inputDisabled = phase === "streaming";
  const streamTailCap = Math.max(3, termSize.rows - 14);
  const streamRowsFloor = streamText !== "" ? textRows(tailForHeight(streamText, streamTailCap, termSize.columns), termSize.columns) : 0;
  const thinkingRowsFloor = thinkingText !== "" ? textRows(tailForHeight(thinkingText, 6, termSize.columns), termSize.columns) : 0;
  const overlayActive = showResumePicker || showProjectPicker || showMemoryPicker || phase === "permission";
  let liveFloor = liveRegionFloor({
    streamRows: streamRowsFloor + thinkingRowsFloor,
    streaming: phase === "streaming",
    compacting: compactPct !== undefined,
    // InputBox's exact reported row count while visible (see onInputRowsChange
    // wiring below), 0 when hidden.
    inputRows: inputVisible ? inputRows : 0,
    // ResumePicker/ProjectPicker/PermissionDialog: now a TRUE upper bound
    // rather than a guess. ResumePicker/ProjectPicker are windowed to at
    // most SuggestionMenu's MAX_ROWS=8 visible entries (see visibleWindow
    // reuse in those components), so their worst case is
    // border(2) + header(1) + 8 entries = 11 rows regardless of how many
    // sessions/projects exist. PermissionDialog's toolLabel line is
    // truncated (see transcript.ts's truncate, now exported) so it can't
    // grow unboundedly either. 12 leaves one spare row of margin.
    overlayRows: overlayActive ? 12 : 0
  });
  // InputBox renders a 4th row ("working… (Esc to interrupt)") when disabled
  // that the flat inputVisible -> +3 baseline above doesn't model.
  if (inputVisible && inputDisabled) liveFloor += 1;
  // The suggestion menu (up to SuggestionMenu's MAX_ROWS=8) is owned by
  // InputBox's local state; menuRows is its exact current row count,
  // reported same-batch via onMenuRowsChange (see InputBox.tsx), so this is
  // precise rather than a fixed worst-case reserve baked into every frame
  // the input is enabled (which would keep the footer permanently off the
  // bottom edge whenever the user could type — see bottomFill.ts history).
  if (inputVisible && !inputDisabled) liveFloor += menuRows;

  // Resize-transition safety net: read-and-clear so only the ONE render
  // right after a resize event uses filler=0 (measured/floor values lag one
  // render behind the resize); every later render (including ones caused by
  // the effects that catch those values up) goes through the normal
  // fillerHeight calculation again. See resizeSafeFillerHeight in
  // bottomFill.ts for why this is safe.
  const justResized = justResizedRef.current;
  justResizedRef.current = false;

  // The reserve can never drop to 0: Ink terminates every frame with "\n"
  // (see ink's log-update), so a frame whose content reaches the terminal's
  // bottom row scrolls the screen by one — permanently clipping the top of
  // the <Static> transcript, which Ink never repaints. With a reserve of 1
  // the frame ends one row short and the trailing newline lands exactly on
  // the bottom row without scrolling. This also covers the growth/transition
  // frames (streaming, overlays, suggestion menu, measureElement lag) that a
  // former steadyIdle flag used to special-case by picking 0 vs 1.
  const reserve = 1;
  const liveRows = Math.max(dynamicRows, liveFloor);
  let filler = resizeSafeFillerHeight(
    termSize.rows,
    transcriptRows,
    liveRows,
    justResized,
    reserve
  );
  // Once the transcript exceeds one screen the base filler is 0 and the frame
  // just renders wherever the previous frame's erase left the cursor. That is
  // fine while the live region grows or holds height, but when it shrinks
  // (tall stream tail committed to <Static> on "result") the short new frame
  // ends far above the terminal's bottom edge, with dead blank rows below.
  // Anchor the frame's bottom edge instead: pad by what the previous frame
  // occupied, minus the static rows committed this render (which are written
  // between the erase and the new frame and push the cursor back down).
  if (prevTranscriptKeyRef.current !== transcriptKey) {
    prevTranscriptKeyRef.current = transcriptKey;
    prevFrameRowsRef.current = 0;
    prevStaticCountRef.current = 0;
  }
  let committedRows = 0;
  for (let i = prevStaticCountRef.current; i < items.length; i++) {
    committedRows += itemRows(items[i], termSize.columns);
  }
  prevStaticCountRef.current = items.length;
  if (filler === 0 && !justResized) {
    filler = Math.max(0, Math.min(
      prevFrameRowsRef.current - committedRows - liveRows,
      termSize.rows - reserve - liveRows
    ));
  }
  prevFrameRowsRef.current = filler + liveRows;

  return (
    <ThemeProvider theme={THEMES[themeName] ?? THEMES.dark}>
      <Box flexDirection="column">
        <MessageList items={items} staticKey={transcriptKey} />
        {/* Blank space pushing the footer to the terminal's bottom edge while
            the transcript is shorter than the screen (Claude Code-style).
            Sized from estimated transcript rows (Static scrollback cannot be
            measured) plus the measured live region below; goes to 0 once
            output exceeds one screen. Kept outside liveRegionRef so the
            measurement does not include the filler itself. */}
        {filler > 0 && <Box height={filler} flexShrink={0} />}
        <Box flexDirection="column" ref={liveRegionRef}>
          {/* Show only a tail of the streaming text: if the dynamic region
              reaches the terminal height, Ink clears and rewrites the whole
              screen on every delta, which breaks scrolling mid-response. The
              full text is committed to the Static transcript on "result". */}
          {thinkingText !== "" && (
            <Box>
              <Text dimColor wrap="wrap">
                {tailForHeight(thinkingText, 6, termSize.columns)}
              </Text>
            </Box>
          )}
          {streamText !== "" && (
            <Text>
              {/* Reserve rows for everything else in the live region below this
                  text: InputBox border+line (3) + disabled hint (1) +
                  SuggestionMenu's own MAX_ROWS (8) + WorkingIndicator/ProgressBar
                  (1) + StatusBar (1). Falling short here reintroduces the
                  clear-and-repaint jitter this cap exists to avoid. */}
              {tailForHeight(streamText, Math.max(3, termSize.rows - 14), termSize.columns)}
            </Text>
          )}
          {phase === "streaming" && <WorkingIndicator label={activeTool ? `Running ${activeTool}` : "Thinking"} startedAt={workStartedAt} />}
          {compactPct !== undefined && <ProgressBar label="Compacting" pct={compactPct} />}
          {showResumePicker && (
            <ResumePicker
              entries={props.sessionIndex.list()}
              onPick={e => {
                setShowResumePicker(false);
                resetItems();
                const provider = props.providers[e.provider] ? e.provider : providerName;
                setProviderName(provider);
                setModel(props.providers[provider]?.model);
                void restartSession(provider, e.id);
              }}
              onCancel={() => setShowResumePicker(false)}
            />
          )}
          {showProjectPicker && (
            <ProjectPicker
              projects={recentProjects(props.sessionIndex.list(), props.cwd)}
              currentCwd={props.cwd}
              onPick={p => {
                setShowProjectPicker(false);
                const result = resolveProjectPath(p, props.cwd);
                if (!result.ok) { notice(result.error); return; }
                ctx.switchProject(result.path);
              }}
              onCancel={() => setShowProjectPicker(false)}
            />
          )}
          {showMemoryPicker && (
            <MemoryPicker
              options={buildMemoryOptions(props.cwd)}
              onCancel={() => setShowMemoryPicker(false)}
              onPick={o => {
                setShowMemoryPicker(false);
                if (o.kind === "folder") {
                  ensureMemoryDir(o.path);
                  openFolder(o.path);
                  notice(`Opened ${o.path}`);
                  return;
                }
                const r = openInEditor(o.path);
                notice(r.hint);
                if (r.ok) sessionRef.current?.refreshSystemPrompt();
              }}
            />
          )}
          {phase === "permission" && activePermission && (
            <PermissionDialog request={activePermission} onDecision={decidePermission} />
          )}
          {!showResumePicker && !showProjectPicker && !showMemoryPicker && phase !== "permission" && (
            <InputBox
              completionCtx={completionCtx}
              onSubmit={handleSubmit}
              disabled={phase === "streaming"}
              history={historyRef.current}
              columns={termSize.columns}
              onMenuRowsChange={rows => setMenuRows(prev => (prev === rows ? prev : rows))}
              onInputRowsChange={rows => setInputRows(prev => (prev === rows ? prev : rows))}
            />
          )}
          <StatusBar
            provider={providerName} model={model} servedModel={servedModel} mode={mode} cwd={props.cwd} costUsd={cost}
            gitBranch={git.branch} gitDirty={git.dirty}
            tokens={tokens} contextPct={contextPct} elapsedMs={elapsedMs}
          />
        </Box>
      </Box>
    </ThemeProvider>
  );
}
