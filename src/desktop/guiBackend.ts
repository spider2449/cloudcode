import { join } from "node:path";
import { GuiServer, splitInputLines } from "./guiServer.js";
import { buildRegistry } from "../commands/builtins.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { loadSkills } from "../agent/skills.js";
import { AgentSession } from "../agent/session.js";
import { loadMcpServers } from "../agent/mcp.js";
import { loadRegistry } from "../engine/lsp/config.js";
import { fetchModels } from "../agent/models.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildGuiCommandContext } from "./guiCommandContext.js";
import { toChatEvents } from "./chatEvents.js";
import { suggestCompletions } from "./guiComplete.js";
import { loadHistoryEvents } from "./chatHistory.js";
import { recordGuiTurn } from "./sessionRecord.js";
import { requireChatCwd } from "./chatProtocol.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { loadProviders } from "../agent/providers.js";
import { loadSettings, saveSetting } from "../agent/settings.js";
import { DEFAULT_STATUS_LINE_ITEMS, normalizeStatusLineItems } from "../statusLineItems.js";
import type { DesktopStatusPayload } from "./statusPayload.js";
import { saveThemeName, THEMES } from "../ui/theme.js";
import { resolveMenuThemeName } from "./appMenu.js";
import type { ProviderConfig } from "../agent/providers.js";
import type { PermissionMode } from "../agent/session.js";
import type { EffortLevel } from "../engine/effort.js";
import type { NetworkMode } from "../agent/networkPolicy.js";

// Headless JSON backend for the desktop GUI shell: per-conversation state,
// turn routing, and the stdin request protocol (complete/history/theme-set/
// status/statusline-set/respond/abort). Extracted verbatim from the guiserver
// block in cli.tsx so the CLI entry stays an entry point; the dynamic import
// in cli.tsx preserves the old lazy-load behavior for TUI startup.
export async function runGuiServer(): Promise<void> {
  const registryEnv = { ...process.env, CLOUDCODE_DESKTOP: "1" };
  const emit = (event: unknown) => { process.stdout.write(`${JSON.stringify(event)}\n`); };
  // Last resort: a GUI backend must stay alive for its stdin pipe. Unhandled
  // rejections are logged loudly to stderr (inherited: visible in the
  // terminal) instead of exiting the process and breaking the desktop app.
  // Request paths above are all total, so reaching here is always a bug.
  process.on("unhandledRejection", reason => {
    console.error(`[gui-server] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  const guiProviders: Record<string, ProviderConfig> = loadProviders();
  const guiSettings = loadSettings();
  const defaultProvider = guiSettings.provider && guiProviders[guiSettings.provider] ? guiSettings.provider : "anthropic";
  // Per-conversation backend state, keyed by workspace + GUI session. The GUI
  // is a thin shell: every turn and every slash command runs here against the
  // same AgentSession/registry machinery as the terminal UI.
  interface GuiKeyState {
    cwd: string;
    sessionId: string | undefined;
    providerName: string;
    model: string | undefined;
    effort: EffortLevel;
    mode: PermissionMode;
    networkMode: NetworkMode;
    costUsd: number;
    turns: number;
    tokens: number;
    contextPct: number | undefined;
    startedAt: number;
    models: string[];
    mcpDisabled: Set<string>;
  }
  const keyStates = new Map<string, GuiKeyState>();
  const sessions = new Map<string, InstanceType<typeof AgentSession>>();
  // Same sessions.json the terminal UI and DesktopShellHost read, so GUI
  // turns appear in the sidebar and survive app restarts.
  const guiSessionIndex = new SessionIndex();
  const permissionStores = new Map<string, InstanceType<typeof PermissionStore>>();
  const inFlight = new Map<string, string>();
  const turnDone = new Map<string, () => void>();
  const pendingPermission = new Map<string, (allow: boolean) => void>();
  const sessionKey = (cwd: string, sessionId: string | undefined): string => `${cwd}::${sessionId ?? ""}`;
  function keyState(cwd: string, sessionId: string | undefined): GuiKeyState {
    const key = sessionKey(cwd, sessionId);
    const existing = keyStates.get(key);
    if (existing) return existing;
    const providerName = defaultProvider;
    const state: GuiKeyState = {
      cwd, sessionId, providerName,
      model: guiSettings.model ?? guiProviders[providerName]?.model,
      effort: guiSettings.effort ?? "off",
      mode: guiSettings.permissionMode ?? "default",
      networkMode: guiSettings.networkMode ?? "providerOnly",
      costUsd: 0, turns: 0, tokens: 0, contextPct: undefined,
      startedAt: Date.now(), models: [], mcpDisabled: new Set<string>()
    };
    keyStates.set(key, state);
    return state;
  }
  function refreshModels(key: string, state: GuiKeyState): void {
    void fetchModels(guiProviders[state.providerName] ?? {}).then(models => {
      const live = keyStates.get(key);
      if (live) live.models = models;
    }).catch(() => {});
  }
  function getSession(key: string, state: GuiKeyState): InstanceType<typeof AgentSession> {
    const existing = sessions.get(key);
    if (existing) return existing;
    const session = new AgentSession({
      providerName: state.providerName,
      provider: guiProviders[state.providerName],
      model: state.model,
      effort: state.effort,
      permissionMode: state.mode,
      resume: state.sessionId,
      cwd: state.cwd,
      networkMode: state.networkMode,
      mcpServers: loadMcpServers(state.cwd),
      lspRegistry: loadRegistry(undefined, join(state.cwd, ".cloudcode", "lsp.json"), false),
      onMessage: (msg) => {
        if (msg.type === "result" && msg.subtype === "success") {
          if (typeof msg.total_cost_usd === "number") state.costUsd += msg.total_cost_usd;
          const usage = (msg.last_usage ?? msg.usage) as Record<string, number> | undefined;
          if (usage) {
            const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            const output = usage.output_tokens ?? 0;
            state.tokens = input + output;
            const window = guiProviders[state.providerName]?.model_context_window ?? 200_000;
            state.contextPct = Math.min(100, Math.round((input / window) * 100));
          }
        }
        const id = inFlight.get(key);
        if (!id) return;
        for (const event of toChatEvents(id, msg)) emit(event);
        if (msg.type === "result" || msg.type === "limit") {
          inFlight.delete(key);
          turnDone.get(key)?.();
          turnDone.delete(key);
        }
      },
      onPermissionRequest: (req) => {
        const id = inFlight.get(key);
        if (!id) {
          req.resolve(false);
          return;
        }
        pendingPermission.set(id, req.resolve);
        emit({ id, type: "permission_request", toolName: req.toolName, toolInput: req.input });
      },
      onSessionId: () => {},
    });
    session.start();
    sessions.set(key, session);
    refreshModels(key, state);
    return session;
  }
  async function disposeKey(key: string): Promise<void> {
    // Settle a displaced turn waiter first: the session is being torn down by
    // an explicit slash command (/new, /provider, /config), so from the GUI's
    // perspective that turn is over. Late session messages then find no
    // in-flight id and are dropped instead of hanging a waiter forever.
    const finish = turnDone.get(key);
    turnDone.delete(key);
    inFlight.delete(key);
    finish?.();
    const session = sessions.get(key);
    sessions.delete(key);
    await session?.dispose().catch(() => {});
  }
  function permissionStoreFor(cwd: string): InstanceType<typeof PermissionStore> {
    const existing = permissionStores.get(cwd);
    if (existing) return existing;
    const store = new PermissionStore(cwd);
    permissionStores.set(cwd, store);
    return store;
  }
  // Snapshot for the desktop statusline footer. Mirrors nativeApp's
  // statusBarProps: same fields, same settings-backed item list, so /statusline
  // choices apply live in both shells.
  function statusFor(state: GuiKeyState): DesktopStatusPayload {
    return {
      provider: state.providerName,
      model: state.model,
      effort: state.effort,
      mode: state.mode,
      networkMode: state.networkMode,
      cwd: state.cwd,
      costUsd: state.costUsd,
      tokens: state.tokens > 0 ? state.tokens : undefined,
      contextPct: state.contextPct,
      elapsedMs: Date.now() - state.startedAt,
      statusLineItems: loadSettings().statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS,
      inFlightId: inFlight.get(sessionKey(state.cwd, state.sessionId)),
    };
  }
  // Slash-initiated turns (/init, /review, skill prompts): same tracking as
  // runTurn so their output streams to the shell and their permission
  // requests can pop. Previously sendPrompt bypassed inFlight entirely, so
  // its text_deltas were swallowed, its prompts auto-denied, and its
  // turnActive wedged the session. Fire-and-forget like the TUI (the slash
  // request's own done still comes from GuiServer.handle's finally).
  function runSlashPrompt(key: string, state: GuiKeyState, id: string, text: string): void {
    if (inFlight.has(key)) {
      emit({ id, type: "error", text: "A turn is already running for this session." });
      return;
    }
    const session = getSession(key, state);
    state.turns += 1;
    recordGuiTurn(guiSessionIndex, {
      cwd: state.cwd, provider: state.providerName, sessionId: session.sessionId, text
    });
    inFlight.set(key, id);
    void new Promise<void>((resolve) => {
      turnDone.set(key, resolve);
      session.send(text);
    }).then(() => {
      if (state.sessionId === undefined && session.sessionId !== undefined) {
        emit({ id, type: "session_id", sessionId: session.sessionId });
      }
    });
  }
  function buildContext(cwd: string, id: string, key: string, state: GuiKeyState): import("../commands/types.js").CommandContext {
    return buildGuiCommandContext({
      cwd,
      notice: text => emit({ id, type: "notice", text }),
      providers: guiProviders,
      providerName: () => state.providerName,
      availableModels: () => state.models,
      currentModel: () => state.model,
      setCurrentModel: model => { state.model = model; },
      currentEffort: () => state.effort,
      setCurrentEffort: level => { state.effort = level; },
      currentNetworkMode: () => state.networkMode,
      setCurrentNetworkMode: mode => { state.networkMode = mode; },
      sessionCost: () => state.costUsd,
      getSession: () => getSession(key, state),
      runSlashPrompt: text => runSlashPrompt(key, state, id, text),
      restartSession: async provider => {
        if (provider) state.providerName = provider;
        await disposeKey(key);
        return getSession(key, state);
      },
      requestNewSession: () => {
        emit({ id, type: "new_session" });
      },
      emitTheme: name => {
        emit({ id, type: "theme", text: name });
      },
      emitStatusLinePicker: () => {
        emit({ id, type: "statusline_picker", status: statusFor(state) });
      },
      mcpDisabled: () => state.mcpDisabled,
      permissionStore: () => permissionStoreFor(cwd)
    });
  }
  const server = new GuiServer({
    commands: cwd => mergeSkillCommands(buildRegistry(registryEnv), loadSkills(cwd)),
    buildContext: req => {
      const key = sessionKey(req.cwd, req.sessionId);
      return buildContext(req.cwd, req.id, key, keyState(req.cwd, req.sessionId));
    },
    runTurn: async (req, emitTurn) => {
      const key = sessionKey(req.cwd, req.sessionId);
      const state = keyState(req.cwd, req.sessionId);
      // Reject overlapping turns on the same conversation before claiming the slot.
      // Anonymous turns always reuse the workspace's live session: a genuine
      // fresh start arrives as a history(undefined) reset (New Session button),
      // so disposing here would wipe the transcript on every second message.
      if (inFlight.has(key)) {
        emitTurn({ id: req.id, type: "error", text: "A turn is already running for this session." });
        return;
      }
      const session = getSession(key, state);
      state.turns += 1;
      // Persist like the terminal UI: first turn records the index entry
      // (first user text becomes firstMessage), later turns just touch it.
      recordGuiTurn(guiSessionIndex, {
        cwd: state.cwd, provider: state.providerName, sessionId: session.sessionId, text: req.text
      });
      inFlight.set(key, req.id);
      await new Promise<void>((resolve) => {
        turnDone.set(key, resolve);
        session.send(req.text);
      });
      // Tell the GUI the backend id of an anonymous conversation once it has
      // content, so the shell can adopt it (persisted, restorable). Named
      // sessions are already known to the shell and need no announcement.
      if (req.sessionId === undefined && session.sessionId !== undefined) {
        emitTurn({ id: req.id, type: "session_id", sessionId: session.sessionId });
      }
    },
    emit: (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); },
  });
  let buffer = "";
  let historySeq = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const framed = splitInputLines(buffer);
    buffer = framed.rest;
    for (const line of framed.lines) {
      try {
          const request = JSON.parse(line) as { id?: unknown; text?: unknown; cwd?: unknown; kind?: unknown; allow?: unknown; sessionId?: unknown; prefix?: unknown; name?: unknown; items?: unknown };
        if (request.kind === "complete") {
          // Input-box autocomplete: same getSuggestions machinery as the
          // terminal input box. Routed here (not through GuiServer) because
          // suggestions are not a turn and must never touch session state.
          const replyId = typeof request.id === "string" && request.id !== "" ? request.id : `complete-${Date.now()}-${historySeq}`;
          try {
            const prefix = typeof request.prefix === "string" ? request.prefix : "";
            const completeCwd = typeof request.cwd === "string" && request.cwd !== "" ? request.cwd : process.cwd();
            const completeSession = typeof request.sessionId === "string" ? request.sessionId : undefined;
            const completeKey = sessionKey(completeCwd, completeSession);
            const completeState = keyState(completeCwd, completeSession);
            refreshModels(completeKey, completeState);
            emit({
              id: replyId,
              type: "complete",
              items: suggestCompletions(prefix, {
                cwd: completeCwd,
                providers: guiProviders,
                availableModels: completeState.models
              })
            });
            emit({ id: replyId, type: "done" });
          } catch (error) {
            emit({ id: replyId, type: "error", text: error instanceof Error ? error.message : String(error) });
            emit({ id: replyId, type: "done" });
          }
          continue;
        }
        if (request.kind === "history") {
          // History lines are routed here so GuiServer.handle never sees them.
          // A missing session id means a brand-new conversation with no stored
          // transcript, so it replays as empty (done only) and resets the
          // workspace's live anonymous session — that reset is the New Session
          // button's fresh-start signal. Malformed ids and unknown sessions
          // emit error + done and never throw.
          historySeq += 1;
          const replyId = `history-${Date.now()}-${historySeq}`;
          try {
            if (request.sessionId === undefined && typeof request.cwd === "string" && request.cwd !== "") {
              const historyCwd = requireChatCwd(request.cwd) ?? process.cwd();
              void disposeKey(sessionKey(historyCwd, undefined));
            }
            for (const event of loadHistoryEvents(replyId, request.sessionId)) emit(event);
            emit({ id: replyId, type: "done" });
          } catch (error) {
            emit({ id: replyId, type: "error", text: error instanceof Error ? error.message : String(error) });
            emit({ id: replyId, type: "done" });
          }
          continue;
        }
        if (request.kind === "theme-set") {
          // Titlebar Theme menu (Enter on a previewed theme): persist the
          // name and broadcast the same theme chat event the /theme slash
          // path emits, so every renderer recolors immediately. Previews
          // never reach the backend, so browsing stays unpersisted.
          historySeq += 1;
          const replyId = `theme-${Date.now()}-${historySeq}`;
          try {
            const name = resolveMenuThemeName(request.name, Object.keys(THEMES));
            if (!name) throw new Error(`Unknown theme: ${String(request.name)}. Themes: ${Object.keys(THEMES).join(", ")}`);
            saveThemeName(name);
            emit({ id: replyId, type: "theme", text: name });
            emit({ id: replyId, type: "done" });
          } catch (error) {
            emit({ id: replyId, type: "error", text: error instanceof Error ? error.message : String(error) });
            emit({ id: replyId, type: "done" });
          }
          continue;
        }
        if (request.kind === "status") {
          // Statusline footer polling: same correlation pattern as "complete".
          // Never touches session state beyond reading the per-key snapshot.
          historySeq += 1;
          const replyId = typeof request.id === "string" && request.id !== "" ? request.id : `status-${Date.now()}-${historySeq}`;
          try {
            const statusCwd = typeof request.cwd === "string" && request.cwd !== "" ? request.cwd : process.cwd();
            const statusSession = typeof request.sessionId === "string" ? request.sessionId : undefined;
            emit({ id: replyId, type: "status", status: statusFor(keyState(statusCwd, statusSession)) });
            emit({ id: replyId, type: "done" });
          } catch (error) {
            emit({ id: replyId, type: "error", text: error instanceof Error ? error.message : String(error) });
            emit({ id: replyId, type: "done" });
          }
          continue;
        }
        if (request.kind === "statusline-set") {
          // Picker dialog save: validates like settings.loadSettings, persists
          // to settings.json, then broadcasts the fresh snapshot so the footer
          // repaints without waiting for the next poll.
          historySeq += 1;
          const replyId = typeof request.id === "string" && request.id !== "" ? request.id : `statusline-${Date.now()}-${historySeq}`;
          try {
            const next = normalizeStatusLineItems(request.items);
            if (!next) throw new Error("Invalid statusline items.");
            saveSetting("statusLineItems", next);
            const statusCwd = typeof request.cwd === "string" && request.cwd !== "" ? request.cwd : process.cwd();
            const statusSession = typeof request.sessionId === "string" ? request.sessionId : undefined;
            emit({ id: replyId, type: "status", status: statusFor(keyState(statusCwd, statusSession)) });
            emit({ id: replyId, type: "done" });
          } catch (error) {
            emit({ id: replyId, type: "error", text: error instanceof Error ? error.message : String(error) });
            emit({ id: replyId, type: "done" });
          }
          continue;
        }
        if (request.kind === "respond") {
          if (typeof request.id === "string" && typeof request.allow === "boolean") {
            pendingPermission.get(request.id)?.(request.allow);
            pendingPermission.delete(request.id);
          }
          continue;
        }
        if (request.kind === "abort") {
          if (typeof request.id === "string") {
            let key: string | undefined;
            for (const [candidate, value] of inFlight) {
              if (value === request.id) {
                key = candidate;
                break;
              }
            }
            // Unknown ids no-op: never fall back to another session.
            if (key !== undefined) {
              // Deny an outstanding permission prompt first: the loop awaits
              // requestPermission with no abort awareness, so interrupt()
              // alone would leave the turn (and inFlight) wedged forever.
              pendingPermission.get(request.id)?.(false);
              pendingPermission.delete(request.id);
              void sessions.get(key)?.interrupt();
            }
          }
          continue;
        }
        void server.handle({ id: request.id, text: request.text, cwd: request.cwd, sessionId: request.sessionId });
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: "unknown", type: "error", text: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
  });
  // Top-level return is not valid in a module, so gate the rest of the CLI
  // (subcommand/TUI branches below) on stdin closing instead. The data
  // listener above keeps the event loop alive while the GUI holds the pipe.
  await new Promise<void>((resolve) => process.stdin.on("end", () => resolve()));
  process.exit(0);
}
