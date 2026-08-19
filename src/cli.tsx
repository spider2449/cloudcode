#!/usr/bin/env node
import { basename } from "node:path";
import { App } from "./ui/nativeApp.js";
import { Terminal } from "./ui/term/terminal.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { loadMcpServersByScope } from "./agent/mcp.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";
import { loadCustomThemes } from "./ui/theme.js";
import { parseCli, HELP_TEXT, networkModeFromArgs } from "./cliArgs.js";
import { configReport } from "./commands/cli/config.js";
import { formatMcpList } from "./commands/cli/mcpList.js";
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
import { runPackCommand } from "./commands/cli/pack.js";
import { runMaintainCommand } from "./commands/cli/maintain.js";
import { createMaintenanceExecutor } from "./commands/cli/maintenanceExecutor.js";

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
    case "mcp":
      console.log(formatMcpList(loadMcpServersByScope(process.cwd())));
      break;
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
      const result = await runTaskCommand(parsed.args, { cwd: process.cwd(), networkMode: mode });
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
  kind: "interactive" as const, continue: false, resume: false,
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

const sessionIndex = new SessionIndex();
if (taskLaunch) process.chdir(taskLaunch.cwd);
const initialCwd = taskLaunch?.cwd ?? process.cwd();
let resume: string | undefined;
if (taskLaunch?.resume) resume = taskLaunch.resume;
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
        task: currentTask && taskRunner ? {
          initialPrompt: currentTask.initialPrompt,
          planning: currentTask.planning,
          onSessionId: id => taskRunner.recordSession(currentTask.taskId, id),
          onPlanningComplete: id => taskRunner.markPlanReady(currentTask.taskId, id)
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
