# `cloudcode setup` Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `cloudcode setup` subcommand — a readline wizard that interactively sets provider/model, network mode, MCP servers, file-permission rules, and appearance settings, advertised in `cloudcode -h`.

**Architecture:** New orchestration module `src/commands/cli/setup.ts` following the injectable-deps pattern of `src/commands/cli/login.ts`. All writes go through existing config owners: new `saveMcpServer`/`removeMcpServer` helpers in `agent/mcp.ts`, a new `removeAt` on `PermissionStore`, and existing `saveSetting`. Save-as-you-go per section; Ctrl+C keeps completed sections.

**Tech Stack:** TypeScript (strict), Node `readline`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-setup-wizard-design.md`

---

## Conventions (apply to every task)

- **Every commit must bump the patch version first** (AGENTS.md). Task 1 creates `scripts/bump-version.mjs` for this; from Task 2 on, run `node scripts/bump-version.mjs` immediately before every `git commit`.
- Comments in all code must be in English (AGENTS.md).
- Run tests with `npx vitest run <file>` from the repo root.
- After each task also run `npm run lint && npm run lint:size` to catch issues early.

---

### Task 1: Version-bump helper script

**Files:**
- Create: `scripts/bump-version.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/bump-version.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";

// Bumps the patch version everywhere AGENTS.md requires it to agree:
// package.json, package-lock.json (both occurrences), src/version.ts,
// installer/cloudcode.iss. tests/packaging.test.ts enforces the agreement.

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
if ([major, minor, patch].some(n => !Number.isInteger(n))) {
  throw new Error(`Unparseable version in package.json: ${pkg.version}`);
}
const next = `${major}.${minor}.${patch + 1}`;

function replaceFirst(text, from, to) {
  const updated = text.replace(from, () => to);
  if (updated === text) throw new Error(`Pattern not found: ${from}`);
  return updated;
}

let pkgText = replaceFirst(
  readFileSync("package.json", "utf8"),
  `"version": "${pkg.version}"`,
  `"version": "${next}"`
);
writeFileSync("package.json", pkgText);

let lockText = readFileSync("package-lock.json", "utf8");
for (let i = 0; i < 2; i++) {
  lockText = replaceFirst(lockText, `"version": "${pkg.version}"`, `"version": "${next}"`);
}
writeFileSync("package-lock.json", lockText);

writeFileSync(
  "src/version.ts",
  replaceFirst(readFileSync("src/version.ts", "utf8"), `VERSION = "${pkg.version}"`, `VERSION = "${next}"`)
);
writeFileSync(
  "installer/cloudcode.iss",
  replaceFirst(
    readFileSync("installer/cloudcode.iss", "utf8"),
    `#define AppVersion "${pkg.version}"`,
    `#define AppVersion "${next}"`
  )
);
console.log(`${pkg.version} -> ${next}`);
```

- [ ] **Step 2: Verify it works**

Run: `node scripts/bump-version.mjs`
Expected output: `0.1.x -> 0.1.(x+1)` matching the current version.

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS — the four locations now agree on the bumped version.

- [ ] **Step 3: Commit (script + the version bump it just made)**

```bash
git add scripts/bump-version.mjs package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "chore: add patch-version bump script"
```

---

### Task 2: MCP persistence helpers (`saveMcpServer` / `removeMcpServer`)

**Files:**
- Modify: `src/agent/mcp.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Write failing tests**

Append inside the top-level `describe` in `tests/mcp.test.ts` (add `rmSync` to the existing `node:fs` import if not present):

```ts
import { readFileSync } from "node:fs";
import { saveMcpServer, removeMcpServer } from "../src/agent/mcp.js";

describe("saveMcpServer/removeMcpServer", () => {
  it("saves an stdio server to project scope and preserves unknown top-level keys", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ futureField: { kept: true }, mcpServers: {} }));
    saveMcpServer("gh", { command: "npx", args: ["gh-mcp"] }, "project", cwd, userFile);
    const raw = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(raw.futureField).toEqual({ kept: true });
    expect(raw.mcpServers.gh).toEqual({ command: "npx", args: ["gh-mcp"] });
  });

  it("saves an http server to user scope and overwrites same-named entries", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { command: "old" } } }));
    saveMcpServer("docs", { type: "http", url: "https://u" }, "user", cwd, userFile);
    expect(loadMcpServers(cwd, userFile)).toEqual({ docs: { type: "http", url: "https://u" } });
  });

  it("removes only the named server from the requested scope", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { keep: { command: "k" }, drop: { command: "d" } } }));
    removeMcpServer("drop", "user", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).user).toEqual({ keep: { command: "k" } });
  });

  it("creates the file when missing", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "nested", "mcp.json");
    saveMcpServer("x", { command: "x" }, "user", cwd, userFile);
    expect(loadMcpServers(cwd, userFile)).toEqual({ x: { command: "x" } });
  });
});
```

Note: `tests/mcp.test.ts` already imports `loadMcpServers`; add `loadMcpServersByScope` to that import and the two new function imports at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL — `saveMcpServer` is not exported.

- [ ] **Step 3: Implement**

In `src/agent/mcp.ts`, change the first import line to:

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
```

Add after `readServerFile`:

```ts
// Read-modify-write preserving unknown top-level keys, mirroring the
// loadRaw/saveSetting convention in agent/settings.ts.
function writeServerFile(filePath: string, servers: Record<string, McpServerConfig>): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    // missing or invalid file: start from an empty object
  }
  raw.mcpServers = servers;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(raw, null, 2));
}

export function saveMcpServer(
  name: string,
  config: McpServerConfig,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  servers[name] = config;
  writeServerFile(filePath, servers);
}

export function removeMcpServer(
  name: string,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  delete servers[name];
  writeServerFile(filePath, servers);
}
```

(`dirname` and `join` are already imported in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/agent/mcp.ts tests/mcp.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(agent): MCP server save/remove helpers"
```

---

### Task 3: `PermissionStore.removeAt`

**Files:**
- Modify: `src/agent/permissionStore.ts`
- Test: `tests/permissionStore.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/permissionStore.test.ts` inside the main describe (reuse its existing temp-dir helpers; if it constructs stores directly, follow that pattern):

```ts
it("removeAt deletes exactly the indexed rule and persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-removeat-"));
  const store = new PermissionStore(dir);
  store.rememberCommand("git", "allow");
  store.rememberHost("WebFetch", "example.com", "deny");
  store.removeAt(0);
  expect(store.list()).toEqual([{ tool: "WebFetch", decision: "deny", host: "example.com" }]);
  const reloaded = new PermissionStore(dir);
  expect(reloaded.list()).toEqual([{ tool: "WebFetch", decision: "deny", host: "example.com" }]);
});
```

Adjust the import line if `mkdtempSync`/`tmpdir` are not already imported there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permissionStore.test.ts`
Expected: FAIL — `store.removeAt is not a function`.

- [ ] **Step 3: Implement**

In `src/agent/permissionStore.ts`, add directly below `clear()`:

```ts
removeAt(index: number): void {
  this.rules.splice(index, 1);
  this.persist();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/permissionStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/agent/permissionStore.ts tests/permissionStore.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(agent): PermissionStore.removeAt for rule deletion"
```

---

### Task 4: Register `setup` subcommand and help text

**Files:**
- Modify: `src/cliArgs.ts:8` and `src/cliArgs.ts:21-51`
- Test: `tests/cliArgs.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/cliArgs.test.ts` inside the main describe:

```ts
it("routes setup as a subcommand", () => {
  expect(parseCli(["setup"])).toEqual({ kind: "subcommand", name: "setup", args: [] });
});

it("help text advertises setup", () => {
  expect(HELP_TEXT).toMatch(/^ {2}setup {4}Interactive walkthrough/m);
});
```

Add `HELP_TEXT` to the existing import from `../src/cliArgs.js` if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL — `Unknown command "setup"` and help-text mismatch.

- [ ] **Step 3: Implement**

In `src/cliArgs.ts` line 8, extend the tuple and keep alphabetical order:

```ts
export const SUBCOMMANDS = ["doctor", "config", "mcp", "update", "task", "pack", "maintain", "login", "setup"] as const;
```

In `HELP_TEXT`, insert one line after the `login` line so the Commands block reads (match the existing two-space indent and column alignment):

```
Commands:
  doctor    Check environment and configuration health
  config    Show config file paths and effective settings
  mcp       List configured MCP servers
  update    Update cloudcode to the latest version
   task      Run an isolated local engineering task
   pack      Manage local workflow packs
   maintain  Run bounded local maintenance profiles
  login     Sign in with a Claude.ai subscription (login | logout | status)
  setup     Interactive walkthrough of providers, MCP servers, permissions, and settings
```

(The odd leading spaces on task/pack/maintain are pre-existing; leave them untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/cliArgs.ts tests/cliArgs.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): register setup subcommand in help"
```

---

### Task 5: Setup wizard — settings sections (provider/model, network mode, appearance)

**Files:**
- Create: `src/commands/cli/setup.ts`
- Test: `tests/cliSetup.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/cliSetup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupCommand, type SetupDeps } from "../src/commands/cli/setup.js";

function scriptDeps(answers: string[]): { deps: SetupDeps; configBase: string; cwd: string } {
  const queue = [...answers];
  const configBase = mkdtempSync(join(tmpdir(), "setup-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "setup-cwd-"));
  const deps: SetupDeps = {
    configBase,
    cwd,
    promptText: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("prompt script exhausted");
      return next;
    }
  };
  return { deps, configBase, cwd };
}

const settingsOf = (configBase: string) =>
  JSON.parse(readFileSync(join(configBase, "settings.json"), "utf8"));

describe("runSetupCommand settings sections", () => {
  it("saves provider, model, network mode, theme, effort, and memory answers", async () => {
    const { deps, configBase } = scriptDeps([
      "acme", "my-model",
      "unrestricted",
      "dracula", "high", "n"
    ]);
    const result = await runSetupCommand([], deps);
    expect(result.exitCode).toBe(0);
    expect(settingsOf(configBase)).toEqual({
      provider: "acme",
      model: "my-model",
      networkMode: "unrestricted",
      theme: "dracula",
      effort: "high",
      autoMemoryEnabled: false
    });
  });

  it("Enter keeps current values and writes nothing when nothing changes", async () => {
    const { deps, configBase } = scriptDeps(["", "", "", "", "", ""]);
    await runSetupCommand([], deps);
    expect(existsSync(join(configBase, "settings.json"))).toBe(false);
  });

  it("re-prompts on invalid network mode and invalid effort before accepting", async () => {
    const { deps, configBase } = scriptDeps([
      "", "",
      "bogus", "providerOnly",
      "", "nope", "low", ""
    ]);
    await runSetupCommand([], deps);
    const s = settingsOf(configBase);
    expect(s.networkMode).toBe("providerOnly");
    expect(s.effort).toBe("low");
  });

  it("rejects unknown provider names without saving them", async () => {
    const { deps, configBase } = scriptDeps(["ghost", "", "", "", "", ""]);
    await runSetupCommand([], deps);
    expect(settingsOf(configBase)["provider"]).toBeUndefined();
  });

  it("ends with a summary containing effective values", async () => {
    const { deps } = scriptDeps(["", "", "", "", "", ""]);
    const result = await runSetupCommand([], deps);
    expect(result.stdout).toContain("Effective settings:");
  });
});
```

Also clean up temp dirs between runs is optional here (tmpdir litter is accepted by other tests in this repo).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cliSetup.test.ts`
Expected: FAIL — cannot resolve `../src/commands/cli/setup.js`.

- [ ] **Step 3: Implement the module skeleton plus settings sections**

Create `src/commands/cli/setup.ts`:

```ts
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { configDir, loadProviders } from "../../agent/providers.js";
import { loadSettings, saveSetting } from "../../agent/settings.js";
import {
  loadMcpServersByScope, saveMcpServer, removeMcpServer, type McpServerConfig
} from "../../agent/mcp.js";
import { PermissionStore, type PermissionRule } from "../../agent/permissionStore.js";
import { EFFORT_LEVELS } from "../../engine/effort.js";
import { isPersistedNetworkMode } from "../../agent/networkPolicy.js";
import { configReport } from "./config.js";

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
    const answer = (await prompt(`Network mode offlineStrict|providerOnly|unrestricted [${current}]: `)).trim();
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
  const cwd = deps.cwd ?? process.cwd();
  const prompt = deps.promptText ?? defaultPrompt;

  await configureProviderModel(prompt, configBase);
  await configureNetworkMode(prompt, configBase);
  await configureAppearance(prompt, configBase);

  return { exitCode: 0, stdout: `\n${configReport(configBase)}` };
}
```

Notes:
- The unused imports (`loadMcpServersByScope`, `saveMcpServer`, `removeMcpServer`, `McpServerConfig`, `PermissionStore`) will be consumed by Task 6 — leave them out for now and add them in Task 6 instead, so lint stays clean. In this task import only what is used.
- Check `isPersistedNetworkMode`'s declared parameter type in `src/agent/networkPolicy.ts`; if it accepts `unknown`, pass the string directly (as written).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cliSetup.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no unresolved-import or unused-variable errors.

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/cli/setup.ts tests/cliSetup.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): setup wizard settings sections"
```

---

### Task 6: Setup wizard — MCP servers and permission rules sections

**Files:**
- Modify: `src/commands/cli/setup.ts`
- Test: `tests/cliSetup.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/cliSetup.test.ts`:

```ts
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("runSetupCommand mcp section", () => {
  it("adds stdio server to project scope and http server to user scope, then done", async () => {
    const { deps, configBase, cwd } = scriptDeps([
      "", "",
      "a", "gh", "stdio", "npx", "gh-mcp --stdio", "project",
      "a", "docs", "http", "https://mcp.example/sse", "user",
      "d",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const projectRaw = readJson(join(cwd, ".mcp.json"));
    expect(projectRaw.mcpServers.gh).toEqual({ command: "npx", args: ["gh-mcp", "--stdio"] });
    const userRaw = readJson(join(configBase, "mcp.json"));
    expect(userRaw.mcpServers.docs).toEqual({ type: "http", url: "https://mcp.example/sse" });
  });

  it("preserves unknown top-level keys when writing .mcp.json", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "a", "x", "stdio", "node", "", "project", "d",
      "", "", ""
    ]);
    const projectFile = join(cwd, ".mcp.json");
    writeFileSync(projectFile, JSON.stringify({ futureField: { kept: true }, mcpServers: {} }));
    await runSetupCommand([], deps);
    expect(readJson(projectFile).futureField).toEqual({ kept: true });
  });

  it("removes a listed server by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "r", "1", "d",
      "", "", ""
    ]);
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { old: { command: "o" } } }));
    await runSetupCommand([], deps);
    expect(readJson(join(cwd, ".mcp.json")).mcpServers).toEqual({});
  });
});

describe("runSetupCommand permissions section", () => {
  it("adds bash allow, directory deny, removes by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "allow", "bash", "git",
      "deny", "dir", "Edit", "D:/secret",
      "remove", "1",
      "done",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const store = new PermissionStore(cwd);
    expect(store.checkCommand("git status")).toBeUndefined(); // rule was removed again
    expect(store.check("Edit", "D:/secret/file.txt")).toBe("deny");
    expect(store.checkCommand("npm test")).toBeUndefined();
  });

  it("keeps an allowed prefix usable end to end", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "allow", "bash", "pytest",
      "done",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const store = new PermissionStore(cwd);
    expect(store.checkCommand("pytest -q")).toBe("allow");
  });
});
```

Update the imports at the top of the test file: add `writeFileSync` to the `node:fs` import and `PermissionStore` from `../src/agent/permissionStore.js`.

The empty-string answers map to: provider Enter, model Enter, network-mode Enter, theme Enter, effort Enter, memory Enter — the exact count/order must match the final section order implemented in Step 3 (provider → network → MCP → permissions → appearance). Adjust the scripted blanks if you reorder.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cliSetup.test.ts`
Expected: FAIL — MCP/permissions prompts never happen; `.mcp.json`/`permissions.json` not written.

- [ ] **Step 3: Implement the two sections**

In `src/commands/cli/setup.ts`, restore the full import block shown in Task 5 Step 3 (including `loadMcpServersByScope`, `saveMcpServer`, `removeMcpServer`, `type McpServerConfig`, `PermissionStore`). Then add these functions above `runSetupCommand`:

```ts
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
    return console.log('Invalid scope; skipped.');
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
    const action = (await prompt("add/remove/done: ")).trim().toLowerCase();
    if (action === "" || action === "done") return;
    if (action === "add") await addServer(prompt, cwd, userPath);
    else if (action === "remove") {
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
    } else console.log("Choose add, remove, or done.");
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
```

Rewrite the body of `runSetupCommand` so the section order matches the spec (and the scripted blank-answer counts in the tests):

```ts
  await configureProviderModel(prompt, configBase);
  await configureNetworkMode(prompt, configBase);
  await configureMcp(prompt, cwd, join(configBase, "mcp.json"));
  await configurePermissions(prompt, cwd);
  await configureAppearance(prompt, configBase);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cliSetup.test.ts tests/mcp.test.ts tests/permissionStore.test.ts`
Expected: PASS

If the blank-count assertions misfire, recount: provider(1) + model(1) + network(1) + MCP loop prompts + permission loop prompts + theme(1) + effort(1) + memory(1), and fix the scripted answers accordingly.

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/cli/setup.ts tests/cliSetup.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): setup wizard mcp and permission sections"
```

---

### Task 7: Wire dispatch in `cli.tsx` and full-suite verification

**Files:**
- Modify: `src/cli.tsx` (imports near top; switch statement around line 108)

- [ ] **Step 1: Add the dispatch case**

In `src/cli.tsx`, add to the imports from `./commands/cli/…`:

```ts
import { runSetupCommand } from "./commands/cli/setup.js";
```

Inside the subcommand `switch (parsed.name)` block (after the `login` case), add:

```tsx
    case "setup": {
      const result = await runSetupCommand(parsed.args, {});
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
      break;
    }
```

- [ ] **Step 2: Smoke-test the binary entry point non-interactively**

Run: `npx tsx src/cli.tsx --help`
Expected: help text includes the `setup` line.

Run (Ctrl+C out of it after seeing the provider banner): `echo. | npx tsx src/cli.tsx setup`
Expected: prints provider list and prompts; EOF/empty answers walk through without crashing, ends printing the `configReport` summary. On Windows PowerShell use `"" | npx tsx src/cli.tsx setup`.

- [ ] **Step 3: Full verification**

Run: `npm run build && npm test && npm run lint && npm run lint:size`
Expected: build succeeds, all tests pass, lint clean, no file over size limits.

- [ ] **Step 4: Commit**

```bash
node scripts/bump-version.mjs
git add src/cli.tsx package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): dispatch cloudcode setup subcommand"
```

---

## Self-review notes

- Spec coverage: help text (Task 4), provider/model + network mode (Task 5), MCP add/remove both scopes with key preservation (Tasks 2+6), permission dir/prefix/host routing + removal (Tasks 3+6), appearance (Task 5), summary via configReport (Task 5), layering/error handling per spec (Task 5 structure), testing matrix (all tasks).
- Type consistency: `saveMcpServer(name, config, scope, cwd, userPath?)` used identically in Tasks 2 and 6; `removeAt(index)` defined Task 3, used Task 6; `SetupDeps`/`runSetupCommand` signatures consistent across Tasks 5–7.
- Menu-word choices avoid single-letter ambiguity: MCP uses add/remove/done; permissions uses allow/deny/remove/done (empty input = done).
