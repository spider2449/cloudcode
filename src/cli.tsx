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
import { parseCli, HELP_TEXT } from "./cliArgs.js";
import { configReport } from "./commands/cli/config.js";
import { formatMcpList } from "./commands/cli/mcpList.js";
import { runDoctor, formatDoctor } from "./commands/cli/doctor.js";
import { runUpdate } from "./commands/cli/update.js";
import { runPrint, readStdin } from "./printMode.js";

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
  process.exit(1);
}
if (parsed.kind === "subcommand") {
  switch (parsed.name) {
    case "config":
      console.log(configReport());
      break;
    case "mcp":
      console.log(formatMcpList(loadMcpServersByScope(process.cwd())));
      break;
    case "doctor": {
      const checks = runDoctor();
      console.log(formatDoctor(checks));
      if (checks.some(c => !c.ok)) process.exitCode = 1;
      break;
    }
    case "update":
      process.exitCode = runUpdate();
      break;
  }
  process.exit();
}

const providers = loadProviders();
const settings = loadSettings();
let providerName = parsed.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (parsed.provider) {
    console.error(`Unknown provider "${parsed.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(1);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}

const sessionIndex = new SessionIndex();
const initialCwd = process.cwd();
let resume: string | undefined;
if (parsed.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

if (parsed.kind === "print") {
  void (async () => {
    let prompt = parsed.prompt;
    if (prompt === undefined || prompt.trim() === "") {
      if (process.stdin.isTTY) {
        console.error("No prompt given. Pass one as an argument or pipe it on stdin.");
        process.exit(1);
      }
      prompt = (await readStdin()).trim();
      if (prompt === "") {
        console.error("Empty prompt on stdin.");
        process.exit(1);
      }
    }
    const code = await runPrint({
      prompt,
      providerName,
      provider: providers[providerName],
      model: settings.model,
      effort: settings.effort,
      permissionMode: parsed.permissionMode,
      resume,
      cwd: initialCwd,
      sessionIndex
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
    let cwd = initialCwd;
    let switchedFrom: string | undefined;
    let pendingResume = resume;
    let pendingOpenResume = parsed.resume;
    for (;;) {
      let switchTo: string | undefined;
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
      await app.run();
      if (!switchTo) break;
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
