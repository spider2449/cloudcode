#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { App as LegacyApp } from "./ui/App.js";
import { App } from "./ui/nativeApp.js";
import { Terminal } from "./ui/term/terminal.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";
import { loadCustomThemes } from "./ui/theme.js";

// Custom themes must be registered before loadThemeName() validates the
// saved name, or a saved custom theme would silently fall back to dark.
for (const warning of loadCustomThemes()) console.error(warning);

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string" },
    version: { type: "boolean", default: false },
    tui: { type: "string", default: "native" }
  }
});

if (values.version) {
  console.log(`cloudcode ${VERSION}`);
  process.exit(0);
}

const providers = loadProviders();
const settings = loadSettings();
let providerName = values.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (values.provider) {
    console.error(`Unknown provider "${values.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(1);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}

const sessionIndex = new SessionIndex();
const initialCwd = process.cwd();
let resume: string | undefined;
if (values.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

if (values.tui === "native") {
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
    let pendingOpenResume = values.resume;
    for (;;) {
      let switchTo: string | undefined;
      const app = new App({
        cwd,
        providers,
        initialProvider: providerName,
        initialModel: settings.model,
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
  })();
} else {
  // Ink draws its first frame at the current cursor position, below the shell
  // prompt and npm's script banner. The bottom-anchoring filler sizes that
  // frame to the full terminal height, so those pre-existing rows push the
  // frame's top (the welcome banner) off-screen. Clear and home first so the
  // frame starts at row 1.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  function Root() {
    const [cwd, setCwd] = React.useState(initialCwd);
    const [prevCwd, setPrevCwd] = React.useState<string | undefined>(undefined);
    const switchProject = (path: string): string | undefined => {
      try {
        process.chdir(path);
      } catch (err) {
        return `Failed to switch project: ${err instanceof Error ? err.message : String(err)}`;
      }
      setPrevCwd(cwd);
      setCwd(path);
      return undefined;
    };
    return (
      <LegacyApp
        key={cwd}
        cwd={cwd}
        providers={providers}
        initialProvider={providerName}
        initialModel={settings.model}
        initialMode={settings.permissionMode}
        resume={prevCwd === undefined ? resume : undefined}
        sessionIndex={sessionIndex}
        openResumeOnStart={prevCwd === undefined ? values.resume : false}
        onSwitchProject={switchProject}
        switchedFrom={prevCwd}
      />
    );
  }
  render(<Root />);
}
