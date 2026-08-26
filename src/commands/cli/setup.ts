import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { configDir, loadProviders } from "../../agent/providers.js";
import { loadSettings, saveSetting } from "../../agent/settings.js";
import { EFFORT_LEVELS } from "../../engine/effort.js";
import { isPersistedNetworkMode } from "../../agent/networkPolicy.js";
import { configReport } from "./config.js";
import type { PermissionRule } from "../../agent/permissionStore.js";

type PromptFn = (label: string) => Promise<string>;

export interface SetupDeps {
  configBase?: string;
  cwd?: string;
  promptText?(label: string): Promise<string>;
}

function defaultPrompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(label, answer => { rl.close(); resolve(answer); }));
}

async function configureProviderModel(prompt: PromptFn, configBase: string): Promise<void> {
  const settingsPath = join(configBase, "settings.json");
  const providers = loadProviders(join(dirname(settingsPath), "providers.json"));
  const current = loadSettings(settingsPath);
  console.log(`\nProviders: ${Object.keys(providers).join(", ")}`);
  const answer = (await prompt(`Provider [${current.provider ?? "anthropic"}]: `)).trim();
  if (answer !== "") {
    if (!(answer in providers)) console.log(`Unknown provider "${answer}". Keeping current.`);
    else saveSetting("provider", answer, settingsPath);
  }
  const model = (await prompt(`Model [${current.model ?? "default"}]: `)).trim();
  if (model !== "") saveSetting("model", model, settingsPath);
}

async function configureNetworkMode(prompt: PromptFn, configBase: string): Promise<void> {
  const settingsPath = join(configBase, "settings.json");
  const current = loadSettings(settingsPath).networkMode ?? "providerOnly";
  while (true) {
    // unrestricted is deliberately not offered: it is invocation-only
    // (--network-mode), never persisted.
    const answer = (await prompt(`Network mode offlineStrict|providerOnly [${current}]: `)).trim();
    if (answer === "") return;
    if (isPersistedNetworkMode(answer)) {
      saveSetting("networkMode", answer, settingsPath);
      return;
    }
    console.log("Invalid network mode.");
  }
}

async function configureAppearance(prompt: PromptFn, configBase: string): Promise<void> {
  const settingsPath = join(configBase, "settings.json");
  const current = loadSettings(settingsPath);
  const theme = (await prompt(`Theme [${current.theme ?? "dark"}]: `)).trim();
  if (theme !== "") saveSetting("theme", theme, settingsPath);
  while (true) {
    const effort = (await prompt(`Effort ${EFFORT_LEVELS.join("|")} [${current.effort ?? "off"}]: `)).trim();
    if (effort === "") break;
    if ((EFFORT_LEVELS as readonly string[]).includes(effort)) {
      saveSetting("effort", effort, settingsPath);
      break;
    }
    console.log("Invalid effort level.");
  }
  const memory = (await prompt(
    `Auto-memory y/n [${current.autoMemoryEnabled === false ? "n" : "y"}]: `
  )).trim().toLowerCase();
  if (memory === "y") saveSetting("autoMemoryEnabled", true, settingsPath);
  else if (memory === "n") saveSetting("autoMemoryEnabled", false, settingsPath);
}

export function describeRule(r: PermissionRule): string {
  const scope = r.dir ?? r.prefix ?? r.host ?? "";
  return `${r.tool} ${r.decision} ${scope}`;
}

export async function runSetupCommand(
  _args: string[],
  deps: SetupDeps
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const configBase = deps.configBase ?? configDir();
  const prompt = deps.promptText ?? defaultPrompt;

  await configureProviderModel(prompt, configBase);
  await configureNetworkMode(prompt, configBase);
  await configureAppearance(prompt, configBase);

  return { exitCode: 0, stdout: `\n${configReport(configBase)}` };
}
