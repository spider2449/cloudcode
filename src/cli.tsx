#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./ui/App.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string" },
    version: { type: "boolean", default: false }
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

function Root() {
  const [cwd, setCwd] = React.useState(initialCwd);
  const [prevCwd, setPrevCwd] = React.useState<string | undefined>(undefined);
  const switchProject = (path: string) => {
    try {
      process.chdir(path);
    } catch (err) {
      console.error(`Failed to switch project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setPrevCwd(cwd);
    setCwd(path);
  };
  return (
    <App
      key={cwd}
      cwd={cwd}
      providers={providers}
      initialProvider={providerName}
      initialModel={settings.model}
      initialMode={settings.permissionMode}
      resume={cwd === initialCwd ? resume : undefined}
      sessionIndex={sessionIndex}
      openResumeOnStart={cwd === initialCwd ? values.resume : false}
      onSwitchProject={switchProject}
      switchedFrom={prevCwd}
    />
  );
}

render(<Root />);
