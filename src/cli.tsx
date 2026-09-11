#!/usr/bin/env node
import { basename } from "node:path";
import { App } from "./ui/nativeApp.js";
import { Terminal } from "./ui/term/terminal.js";
import { loadProviders } from "./agent/providers.js";
import { applyContextWindow } from "./agent/contextProbe.js";
import { loadSettings } from "./agent/settings.js";
import { runMcpCommand } from "./commands/cli/mcp.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";
import { loadCustomThemes } from "./ui/theme.js";
import { parseCli, HELP_TEXT, networkModeFromArgs } from "./cliArgs.js";
import { configReport } from "./commands/cli/config.js";
import { runDoctor, formatDoctor } from "./commands/cli/doctor.js";
import { runUpdate } from "./commands/cli/update.js";
import { runPrint, readStdin } from "./printMode.js";
import {
  NetworkPolicy, NetworkPolicyError, effectiveNetworkMode, providerEndpoint
} from "./agent/networkPolicy.js";
import { NetworkAudit } from "./agent/networkAudit.js";
import { EXIT_CODES } from "./print/exitCodes.js";
import { runTaskCommand, type TaskLaunch } from "./commands/cli/task.js";
import { TaskRunner } from "./agent/taskRunner.js";
import { TaskCoordinator } from "./agent/taskCoordinator.js";
import { runPackCommand } from "./commands/cli/pack.js";
import { runMaintainCommand } from "./commands/cli/maintain.js";
import { createMaintenanceExecutor } from "./commands/cli/maintenanceExecutor.js";
import { runLoginCommand } from "./commands/cli/login.js";
import { runSetupCommand } from "./commands/cli/setup.js";
import { loadOwnCredentials, loadBorrowedCredentials, refreshTokens, isExpired } from "./agent/oauth.js";
import type { ProviderConfig } from "./agent/providers.js";
import type { PermissionMode } from "./agent/session.js";
import type { EffortLevel } from "./engine/effort.js";
import type { NetworkMode } from "./agent/networkPolicy.js";

const parsed = parseCli(process.argv.slice(2));

if (parsed.kind === "help") {
  console.log(HELP_TEXT);
  process.exit(0);
}
if (parsed.kind === "version") {
  console.log(`cloudcode ${VERSION}`);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(parsed.message);
  process.exit(EXIT_CODES.invalidConfiguration);
}
if (parsed.kind === "guiserver") {
  const { GuiServer, splitInputLines } = await import("./desktop/guiServer.js");
  const { buildRegistry } = await import("./commands/builtins.js");
  const { mergeSkillCommands } = await import("./commands/skillCommands.js");
  const { loadSkills } = await import("./agent/skills.js");
  const { AgentSession } = await import("./agent/session.js");
  const { loadMcpServers } = await import("./agent/mcp.js");
  const { loadRegistry } = await import("./engine/lsp/config.js");
  const { fetchModels } = await import("./agent/models.js");
  const { PermissionStore } = await import("./agent/permissionStore.js");
  const { buildGuiCommandContext } = await import("./desktop/guiCommandContext.js");
  const { toChatEvents } = await import("./desktop/chatEvents.js");
  const { suggestCompletions } = await import("./desktop/guiComplete.js");
  const { loadHistoryEvents } = await import("./desktop/chatHistory.js");
  const { recordGuiTurn } = await import("./desktop/sessionRecord.js");
  const { requireChatCwd } = await import("./desktop/chatProtocol.js");
  const { SessionIndex } = await import("./agent/sessionIndex.js");
  const { join } = await import("node:path");
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
      costUsd: 0, turns: 0, models: [], mcpDisabled: new Set<string>()
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
        if (msg.type === "result" && msg.subtype === "success" && typeof msg.total_cost_usd === "number") state.costUsd += msg.total_cost_usd;
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
  function buildContext(cwd: string, id: string, key: string, state: GuiKeyState): import("./commands/types.js").CommandContext {
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
      restartSession: async provider => {
        if (provider) state.providerName = provider;
        await disposeKey(key);
        return getSession(key, state);
      },
      requestNewSession: () => {
        emit({ id, type: "new_session" });
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
        const request = JSON.parse(line) as { id?: unknown; text?: unknown; cwd?: unknown; kind?: unknown; allow?: unknown; sessionId?: unknown; prefix?: unknown };
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
        if (request.kind === "respond") {
          if (typeof request.id === "string" && typeof request.allow === "boolean") {
            pendingPermission.get(request.id)?.(request.allow);
            pendingPermission.delete(request.id);
          }
          continue;
        }
        if (request.kind === "abort") {
          if (typeof request.id === "string") {
            let cwd: string | undefined;
            for (const [key, value] of inFlight) {
              if (value === request.id) {
                cwd = key;
                break;
              }
            }
            // Unknown ids no-op: never fall back to another session.
            if (cwd !== undefined) void sessions.get(cwd)?.interrupt();
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
let taskLaunch: TaskLaunch | undefined;
if (parsed.kind === "subcommand") {
  const networkArg = networkModeFromArgs(parsed.args);
  if (networkArg.error) {
    console.error(networkArg.error);
    process.exit(EXIT_CODES.invalidConfiguration);
  }
  const subSettings = loadSettings();
  let subNetworkMode;
  try {
    subNetworkMode = effectiveNetworkMode(subSettings.networkMode, networkArg.mode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_CODES.invalidConfiguration);
  }
  switch (parsed.name) {
    case "config":
      console.log(configReport(undefined, networkArg.mode));
      break;
    case "mcp": {
      const result = runMcpCommand(parsed.args, process.cwd());
      console.log(result.stdout ?? "");
      if (result.exitCode !== 0) process.exitCode = 1;
      break;
    }
    case "doctor": {
      const checks = runDoctor({ networkMode: subNetworkMode });
      console.log(formatDoctor(checks));
      if (checks.some(c => !c.ok)) process.exitCode = 1;
      break;
    }
    case "update": {
      const providers = loadProviders();
      const name = subSettings.provider ?? "anthropic";
      const provider = providers[name] ?? providers.anthropic ?? {};
      const policy = new NetworkPolicy(subNetworkMode, providerEndpoint(provider), new NetworkAudit());
      try {
        process.exitCode = runUpdate(undefined, undefined, policy);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = err instanceof NetworkPolicyError ? 7 : 1;
      }
      break;
    }
    case "task": {
      const mode = subSettings.networkMode ?? "providerOnly";
      const result = await runTaskCommand(parsed.args, {
        cwd: process.cwd(), networkMode: mode,
        provider: subSettings.provider ?? "anthropic", model: subSettings.model ?? "default"
      });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      if (result.launch) taskLaunch = result.launch;
      else process.exit(result.exitCode);
      break;
    }
    case "pack": {
      const result = runPackCommand(parsed.args, {
        cwd: process.cwd(), networkMode: subNetworkMode
      });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    case "login": {
      const result = await runLoginCommand(parsed.args, { networkMode: subNetworkMode });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    case "setup": {
      const result = await runSetupCommand(parsed.args, {});
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    case "maintain": {
      const providers = loadProviders();
      const providerName = subSettings.provider ?? "anthropic";
      const provider = providers[providerName];
      if (!provider) {
        console.error(`Unknown provider "${providerName}".`);
        process.exit(EXIT_CODES.invalidConfiguration);
      }
      const result = await runMaintainCommand(parsed.args, {
        cwd: process.cwd(), execute: createMaintenanceExecutor({
          providerName, provider, model: subSettings.model, effort: subSettings.effort,
          savedNetworkMode: subSettings.networkMode
        })
      });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
      break;
    }
  }
  if (!taskLaunch) process.exit();
}

const sessionParsed = taskLaunch ? {
  kind: "interactive" as const, continue: false, resume: false, session: undefined,
  provider: undefined, networkMode: taskLaunch.networkMode
} : parsed;
if (sessionParsed.kind !== "interactive" && sessionParsed.kind !== "print") {
  throw new Error("Internal CLI routing error.");
}

const providers = loadProviders();
const settings = loadSettings();
let networkMode;
try {
  networkMode = taskLaunch
    ? (settings.networkMode === "offlineStrict" || taskLaunch.networkMode === "offlineStrict" ? "offlineStrict" : "providerOnly")
    : effectiveNetworkMode(settings.networkMode, sessionParsed.networkMode);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT_CODES.invalidConfiguration);
}
const networkAudit = new NetworkAudit();
let providerName = sessionParsed.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (sessionParsed.provider) {
    console.error(`Unknown provider "${sessionParsed.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(EXIT_CODES.invalidConfiguration);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}

// Best-effort llama.cpp /props probe: fills model_context_window for
// openai-kind providers before any session (interactive, print, or task)
// is constructed. Manual providers.json values always win.
await applyContextWindow(providers[providerName]);

// Resolve OAuth bearer auth once: used when the selected anthropic-kind
// provider carries no explicit key. Refresh needs real egress, so it only
// happens under unrestricted; otherwise an expired token just means off.
const selectedForAuth = providers[providerName] ?? {};
let oauthAuthToken: string | undefined;
if (selectedForAuth.kind !== "openai" && !selectedForAuth.apiKey && !process.env.ANTHROPIC_API_KEY) {
  const oauth = loadOwnCredentials() ?? loadBorrowedCredentials();
  if (oauth && !isExpired(oauth)) {
    oauthAuthToken = oauth.accessToken;
  } else if (oauth?.refreshToken && networkMode === "unrestricted") {
    try { oauthAuthToken = (await refreshTokens(oauth.refreshToken)).accessToken; }
    catch { console.error("OAuth token refresh failed; continuing unauthenticated."); }
  } else if (oauth) {
    console.error("OAuth token expired; refresh requires --network-mode unrestricted.");
  }
}

const sessionIndex = new SessionIndex();
if (taskLaunch) process.chdir(taskLaunch.cwd);
const initialCwd = taskLaunch?.cwd ?? process.cwd();
let resume: string | undefined;
if (taskLaunch?.resume) resume = taskLaunch.resume;
else if (sessionParsed.kind === "interactive" && sessionParsed.session) resume = sessionParsed.session;
else if (sessionParsed.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

if (sessionParsed.kind === "print") {
  void (async () => {
    let prompt = sessionParsed.prompt;
    if (prompt === undefined || prompt.trim() === "") {
      if (process.stdin.isTTY) {
        console.error("No prompt given. Pass one as an argument or pipe it on stdin.");
        process.exit(EXIT_CODES.invalidConfiguration);
      }
      prompt = (await readStdin()).trim();
      if (prompt === "") {
        console.error("Empty prompt on stdin.");
        process.exit(EXIT_CODES.invalidConfiguration);
      }
    }
    const code = await runPrint({
      prompt,
      providerName,
      provider: providers[providerName],
      model: settings.model,
      effort: settings.effort,
      permissionMode: sessionParsed.permissionMode,
      resume,
      cwd: initialCwd,
      sessionIndex,
      trustProjectConfig: sessionParsed.trustProjectConfig,
      networkMode,
      networkAudit,
      oauthAuthToken,
      outputFormat: sessionParsed.outputFormat,
      runLimits: sessionParsed.runLimits
    }, {
      out: text => process.stdout.write(text),
      err: text => process.stderr.write(text)
    });
    process.exit(code);
  })();
} else {
  // Custom themes must be registered before loadThemeName() validates the
  // saved name, or a saved custom theme would silently fall back to dark.
  for (const warning of loadCustomThemes()) console.error(warning);

  const terminal = new Terminal();
  const cleanupAndExit = (code: number) => { terminal.cleanup(); process.exit(code); };
  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("SIGTERM", () => cleanupAndExit(0));
  process.on("SIGHUP", () => cleanupAndExit(0));
  process.on("uncaughtException", err => {
    terminal.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
    terminal.cleanup();
    throw err;
  });

  void (async () => {
    const taskRunner = taskLaunch ? new TaskRunner() : undefined;
    const taskCoordinator = taskLaunch ? new TaskCoordinator() : undefined;
    let pendingTask = taskLaunch;
    let cwd = initialCwd;
    let switchedFrom: string | undefined;
    let pendingResume = resume;
    let pendingOpenResume = sessionParsed.resume;
    for (;;) {
      let switchTo: string | undefined;
      const currentTask = pendingTask;
      terminal.setTitle(`cloudcode - ${basename(cwd)}`);
      const app = new App({
        cwd,
        providers,
        initialProvider: providerName,
        initialMode: settings.permissionMode,
        resume: pendingResume,
        sessionIndex,
        openResumeOnStart: pendingOpenResume,
        switchedFrom,
        networkMode,
        networkAudit,
        oauthAuthToken,
        task: currentTask && taskRunner ? {
          initialPrompt: currentTask.initialPrompt,
          planning: currentTask.planning,
          toolAllowlist: currentTask.toolAllowlist,
          disableMcp: currentTask.disableMcp,
          onSessionId: id => taskRunner.recordSession(currentTask.taskId, id),
          onPlanningComplete: id => taskRunner.markPlanReady(currentTask.taskId, id),
          ...(currentTask.completeReadOnlyWorker && taskCoordinator ? {
            onTurnComplete: (id?: string) => taskCoordinator.completeReadOnlyWorker(currentTask.taskId, id)
          } : {})
        } : undefined,
        onSwitchProject: path => {
          try {
            process.chdir(path);
          } catch (err) {
            return `Failed to switch project: ${err instanceof Error ? err.message : String(err)}`;
          }
          switchTo = path;
          return undefined;
        }
      }, terminal);
      try {
        await app.run();
      } catch (err) {
        terminal.cleanup();
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(err instanceof NetworkPolicyError ? 7 : 1);
      }
      if (!switchTo) break;
      pendingTask = undefined;
      switchedFrom = cwd;
      cwd = switchTo;
      pendingResume = undefined;
      pendingOpenResume = false;
    }
    terminal.cleanup();
    // App.stop() (from /exit or double-Ctrl+C) only resolves run()'s promise;
    // it doesn't touch the process. A lingering handle elsewhere (e.g. a
    // keep-alive HTTP socket to the LLM API) would otherwise keep the event
    // loop alive and the process hanging until an external SIGINT forces it
    // down, same as the SIGINT handler above already does explicitly.
    process.exit(0);
  })();
}
