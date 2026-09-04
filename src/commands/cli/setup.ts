import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { configDir, loadProviders } from "../../agent/providers.js";
import { loadSettings, saveSetting } from "../../agent/settings.js";
import { loadMcpServersByScope, saveMcpServer, removeMcpServer, setMcpServerDisabled, isMcpServerDisabled, type McpServerConfig } from "../../agent/mcp.js";
import { PermissionStore } from "../../agent/permissionStore.js";
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

// One shared interface for the whole wizard. On piped/closed stdin (EOF)
// every prompt resolves "" so the walk-through completes like a series of
// Enters instead of hanging. The interface is left open; the CLI process
// exits right after the wizard returns.
function makeDefaultPrompt(): PromptFn {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let eof = false;
  let pending: ((value: string) => void) | undefined;
  rl.on("close", () => {
    eof = true;
    pending?.("");
    pending = undefined;
  });
  return label => {
    if (eof) return Promise.resolve("");
    return new Promise(resolve => {
      pending = resolve;
      rl.question(label, answer => {
        pending = undefined;
        resolve(answer);
      });
    });
  };
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

async function addServer(prompt: PromptFn, cwd: string, userPath: string): Promise<void> {
  const name = (await prompt("Server name: ")).trim();
  if (name === "") return console.log("No name given; skipped.");
  const transport = (await prompt("Transport stdio|http [stdio]: ")).trim().toLowerCase() || "stdio";
  let config: McpServerConfig;
  if (transport === "http") {
    const url = (await prompt("URL: ")).trim();
    if (url === "") return console.log("No URL given; skipped.");
    config = { type: "http", url };
  } else {
    const command = (await prompt("Command: ")).trim();
    if (command === "") return console.log("No command given; skipped.");
    const args = (await prompt("Arguments (space-separated, optional): ")).trim();
    config = args === "" ? { command } : { command, args: args.split(/\s+/) };
  }
  const scopeInput = (await prompt("Scope user|project [project]: ")).trim().toLowerCase() || "project";
  if (scopeInput !== "user" && scopeInput !== "project") {
    return console.log("Invalid scope; skipped.");
  }
  saveMcpServer(name, config, scopeInput, cwd, userPath);
  console.log(`Saved ${name} (${scopeInput}).`);
}

async function configureMcp(prompt: PromptFn, cwd: string, userPath: string): Promise<void> {
  while (true) {
    console.log("\nMCP servers:");
    const scopes = loadMcpServersByScope(cwd, userPath);
    for (const name of Object.keys(scopes.user)) console.log(`  ${name}  [user]`);
    for (const name of Object.keys(scopes.project)) console.log(`  ${name}  [project]`);
    const action = (await prompt("add/remove/disable/enable/done: ")).trim().toLowerCase();
    if (action === "" || action === "done") return;
    if (action === "add") {
      await addServer(prompt, cwd, userPath);
    } else if (action === "remove") {
      // Project-scope entries first: they shadow same-named user entries.
      const names = [
        ...Object.keys(scopes.project),
        ...Object.keys(scopes.user).filter(n => !(n in scopes.project))
      ];
      if (names.length === 0) { console.log("Nothing to remove."); continue; }
      names.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
      const pick = Number((await prompt("Number to remove: ")).trim());
      if (!Number.isInteger(pick) || pick < 1 || pick > names.length) {
        console.log("Invalid choice; skipped.");
        continue;
      }
      const name = names[pick - 1];
      const scope = name in scopes.project ? "project" : "user";
      removeMcpServer(name, scope, cwd, userPath);
      console.log(`Removed ${name} (${scope}).`);
    } else if (action === "disable" || action === "enable") {
      // Project-scope entries first: they shadow same-named user entries.
      const names = [
        ...Object.keys(scopes.project),
        ...Object.keys(scopes.user).filter(n => !(n in scopes.project))
      ];
      if (names.length === 0) { console.log("Nothing to change."); continue; }
      names.forEach((n, i) => {
        const effective = scopes.project[n] ?? scopes.user[n];
        const marker = effective && isMcpServerDisabled(effective) ? " (disabled)" : "";
        console.log(`  ${i + 1}. ${n}${marker}`);
      });
      const pick = Number((await prompt(`Number to ${action}: `)).trim());
      if (!Number.isInteger(pick) || pick < 1 || pick > names.length) {
        console.log("Invalid choice; skipped.");
        continue;
      }
      const name = names[pick - 1];
      const scope = name in scopes.project ? "project" : "user";
      if (name.startsWith("pack__")) { console.log(`Pack servers cannot be disabled (${name}).`); continue; }
      setMcpServerDisabled(name, action === "disable", scope, cwd, userPath);
      console.log(`${action === "disable" ? "Disabled" : "Enabled"} ${name} (${scope}).`);
    } else console.log("Choose add, remove, disable, enable, or done.");
  }
}

async function configurePermissions(prompt: PromptFn, cwd: string): Promise<void> {
  const store = new PermissionStore(cwd);
  while (true) {
    console.log("\nPermission rules:");
    const rules = store.list();
    if (rules.length === 0) console.log("  (none)");
    rules.forEach((r, i) => console.log(`  ${i + 1}. ${describeRule(r)}`));
    const action = (await prompt("allow/deny/remove/done: ")).trim().toLowerCase();
    if (action === "" || action === "done") return;
    if (action === "allow" || action === "deny") {
      const decision = action === "allow" ? "allow" : "deny";
      const kind = (await prompt("Rule kind dir|bash|host: ")).trim().toLowerCase();
      if (kind === "dir") {
        const tool = (await prompt("Tool (e.g. Edit): ")).trim();
        const dir = (await prompt("Directory: ")).trim();
        if (tool !== "" && dir !== "") store.rememberDir(tool, dir, decision);
        else console.log("Missing tool or directory; skipped.");
      } else if (kind === "bash") {
        const prefix = (await prompt("Command prefix: ")).trim();
        if (prefix !== "") store.rememberCommand(prefix, decision);
        else console.log("Missing prefix; skipped.");
      } else if (kind === "host") {
        const tool = (await prompt("Tool (e.g. WebFetch): ")).trim();
        const host = (await prompt("Host: ")).trim();
        if (tool !== "" && host !== "") store.rememberHost(tool, host, decision);
        else console.log("Missing tool or host; skipped.");
      } else console.log("Unknown rule kind; skipped.");
    } else if (action === "remove") {
      if (rules.length === 0) { console.log("Nothing to remove."); continue; }
      const pick = Number((await prompt("Number to remove: ")).trim());
      if (Number.isInteger(pick) && pick >= 1 && pick <= rules.length) store.removeAt(pick - 1);
      else console.log("Invalid choice; skipped.");
    } else console.log("Choose allow, deny, remove, or done.");
  }
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
  const cwd = deps.cwd ?? process.cwd();
  const prompt = deps.promptText ?? makeDefaultPrompt();

  await configureProviderModel(prompt, configBase);
  await configureNetworkMode(prompt, configBase);
  await configureMcp(prompt, cwd, join(configBase, "mcp.json"));
  await configurePermissions(prompt, cwd);
  await configureAppearance(prompt, configBase);

  return { exitCode: 0, stdout: `\n${configReport(configBase)}` };
}
