# MCP Disable/Enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent `disable`/`enable` operations for MCP servers across CLI, `/mcp`, and setup wizard using a `disabled: true` flag in config files.

**Architecture:** Core flag helpers plus loader filtering in `src/agent/mcp.ts`; thin orchestration in `src/commands/cli/mcp.ts` (new), `src/commands/builtins.ts` (`/mcp`), and `src/commands/cli/setup.ts` (wizard); display markers in `formatMcpList`/`formatMcpStatus`. Disabled servers never reach `McpManager.connect`; changes take effect after `/clear` or restart.

**Tech Stack:** TypeScript (strict), Node.js fs/JSON config files, vitest.

---

## File structure

- `src/agent/mcp.ts` — owner of the flag: `isMcpServerDisabled`, `resolveMcpServerScope`, `setMcpServerDisabled`, plus filtering/stripping inside `loadMcpServers`. No UI knowledge.
- `src/commands/cli/mcpList.ts` — pure rendering: `formatMcpList` gains the `, disabled` marker. No fs writes.
- `src/commands/cli/mcp.ts` — NEW, owns `cloudcode mcp` argument parsing and orchestration (list/disble/enable). Keeps `src/cli.tsx` thin (single delegate call) and `src/cliArgs.ts` limited to help text.
- `src/cli.tsx`, `src/cliArgs.ts` — wiring only: delegate to `runMcpCommand`, update `HELP_TEXT`.
- `src/commands/types.ts`, `src/commands/builtins.ts` — `/mcp` slash surface: new `mcpSetEnabled` context method, arg parsing, completion (subcommands plus server-name hints after `disable `/`enable `).
- `src/commands/completion.ts` — completion plumbing: new `mcpServerNames(): string[]` on `CompletionContext` (plus `LiveCompletionDependencies` and `liveCompletionContext`), following the existing `providerNames`/`availableModels` pattern. No fs access.
- `src/ui/nativeApp.ts` — implements `mcpSetEnabled`, tracks disabled names for status rendering, and wires `mcpServerNames` into `liveCompletionContext` (union of enabled keys plus `mcpDisabled` so disabled names stay completable for `/mcp enable`). No provider/network calls.
- `src/commands/cli/setup.ts` — wizard `disable`/`enable` actions reusing the core helpers.
- Tests mirror sources 1:1: extend `tests/mcp.test.ts`, `tests/mcpList.test.ts`, `tests/commands.test.ts`, `tests/completion.test.ts`, `tests/cliSetup.test.ts`; create `tests/cliMcp.test.ts` for the new CLI module.

Scope check: single subsystem (one flag, three thin surfaces). One plan produces working, testable software.

---

### Task 1: Core flag helpers + loader filtering

**Files:**
- Modify: `src/agent/mcp.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp.test.ts`:

```ts
import { isMcpServerDisabled, resolveMcpServerScope, setMcpServerDisabled } from "../src/agent/mcp.js";

describe("mcp disable/enable flag", () => {
  it("treats only disabled === true as disabled", () => {
    expect(isMcpServerDisabled({ command: "n" })).toBe(false);
    expect(isMcpServerDisabled({ command: "n", disabled: true })).toBe(true);
    expect(isMcpServerDisabled({ command: "n", disabled: false })).toBe(false);
  });

  it("resolves project-first scope and undefined when absent", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { onlyUser: { command: "u" }, both: { command: "u" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { both: { command: "p" } } }));
    expect(resolveMcpServerScope("both", cwd, userFile)).toBe("project");
    expect(resolveMcpServerScope("onlyUser", cwd, userFile)).toBe("user");
    expect(resolveMcpServerScope("missing", cwd, userFile)).toBeUndefined();
  });

  it("sets and clears the flag preserving sibling keys", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["a"] } } }));
    setMcpServerDisabled("gh", true, "project", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).project.gh).toEqual({ command: "npx", args: ["a"], disabled: true });
    setMcpServerDisabled("gh", false, "project", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).project.gh).toEqual({ command: "npx", args: ["a"] });
  });

  it("throws for unknown names", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    expect(() => setMcpServerDisabled("ghost", true, "project", cwd, userFile)).toThrow(/No MCP server named/);
  });

  it("excludes disabled servers from loadMcpServers and strips the flag", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { command: "u" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
      gh: { command: "p", disabled: true },
      docs: { command: "p-override" }
    } }));
    expect(loadMcpServers(cwd, userFile)).toEqual({ docs: { command: "p-override" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL with "isMcpServerDisabled is not defined" (import error).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/mcp.ts`, after `removeMcpServer`, add:

```ts
export function isMcpServerDisabled(config: McpServerConfig): boolean {
  return config.disabled === true;
}

export function resolveMcpServerScope(
  name: string,
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): "user" | "project" | undefined {
  const scopes = loadMcpServersByScope(cwd, userPath);
  if (Object.hasOwn(scopes.project, name)) return "project";
  if (Object.hasOwn(scopes.user, name)) return "user";
  return undefined;
}

export function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  scope: "user" | "project",
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): void {
  const filePath = scope === "user" ? userPath : join(cwd, ".mcp.json");
  const servers = readServerFile(filePath);
  const existing = servers[name];
  if (!existing) throw new Error(`No MCP server named "${name}".`);
  if (disabled) {
    servers[name] = { ...existing, disabled: true };
  } else {
    const next = { ...existing };
    delete next.disabled;
    servers[name] = next;
  }
  writeServerFile(filePath, servers);
}
```

Update `loadMcpServers` to filter and strip after the pack-collision loop, replacing `return merged;` with:

```ts
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (isMcpServerDisabled(config)) continue;
    const next = { ...config };
    delete next.disabled;
    enabled[name] = next;
  }
  return enabled;
```

Note: filtering happens after the existing pack-collision check so a disabled project entry shadowing a pack name keeps today's collision error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS (all suites, including the 5 new tests).

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/agent/mcp.ts tests/mcp.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(agent): MCP disable/enable flag helpers and loader filtering"
```

---

### Task 2: Disabled markers in list and status rendering

**Files:**
- Modify: `src/commands/cli/mcpList.ts`
- Modify: `src/agent/mcp.ts` (formatMcpStatus signature)
- Test: `tests/mcpList.test.ts`
- Test: `tests/mcp.test.ts` (formatMcpStatus block)

- [ ] **Step 1: Write the failing tests**

In `tests/mcpList.test.ts` add:

```ts
it("marks disabled servers", () => {
  const out = formatMcpList({
    user: { old: { command: "o", disabled: true } },
    project: { gh: { command: "g" } }
  });
  expect(out).toContain("old  [user, disabled]");
  expect(out).toContain("gh  [project]");
});
```

In `tests/mcp.test.ts` add to the `formatMcpStatus` describe:

```ts
it("renders disabled servers without status lookup", () => {
  const out = formatMcpStatus(["gh", "docs"], [{ name: "gh", status: "connected" }], ["mcp__gh__t"], new Set(["docs"]));
  expect(out).toBe("gh  connected  tools: t\ndocs  disabled");
});
```

Also update the import in `tests/mcp.test.ts` to include the new helpers (already added in Task 1).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcpList.test.ts tests/mcp.test.ts`
Expected: FAIL — `formatMcpList` output lacks `, disabled`; `formatMcpStatus` takes 3 args so the 4-arg call renders `docs  pending` instead of `docs  disabled`.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/cli/mcpList.ts`, import the helper and mark effective entries:

```ts
import type { McpServersByScope, McpServerConfig } from "../../agent/mcp.js";
import { isMcpServerDisabled } from "../../agent/mcp.js";

function effectiveConfig(scopes: McpServersByScope, name: string): McpServerConfig {
  return (scopes.project[name] ?? scopes.user[name]) as McpServerConfig;
}
```

Change the map body to:

```ts
    const scope = inProject && inUser ? "project (overrides user)" : inProject ? "project" : "user";
    const disabled = isMcpServerDisabled(effectiveConfig(scopes, name)) ? ", disabled" : "";
    return `${name}  [${scope}${disabled}]`;
```

In `src/agent/mcp.ts`, change the signature:

```ts
export function formatMcpStatus(
  configured: string[],
  statuses: McpServerStatusEntry[],
  tools: string[],
  disabled: Set<string> = new Set()
): string {
```

and add as the first statement inside the `.map()` callback:

```ts
      if (disabled.has(name)) return `${name}  disabled`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcpList.test.ts tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/cli/mcpList.ts src/agent/mcp.ts tests/mcpList.test.ts tests/mcp.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): mark disabled MCP servers in list and status output"
```

---

### Task 3: `cloudcode mcp disable/enable` CLI subcommand

**Files:**
- Create: `src/commands/cli/mcp.ts`
- Modify: `src/cli.tsx`
- Modify: `src/cliArgs.ts` (HELP_TEXT only)
- Test: `tests/cliMcp.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/cliMcp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpCommand } from "../src/commands/cli/mcp.js";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "cc-mcpcmd-"));
  const userPath = join(mkdtempSync(join(tmpdir(), "cc-mcpcfg-")), "mcp.json");
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx" } } }));
  writeFileSync(userPath, JSON.stringify({ mcpServers: { docs: { command: "u" } } }));
  return { cwd, userPath };
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("runMcpCommand", () => {
  it("lists servers with scope tags", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand([], cwd, userPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh  [project]");
    expect(result.stdout).toContain("docs  [user]");
  });

  it("disables a project server and reports the scope", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand(["disable", "gh"], cwd, userPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Disabled gh (project). Restart or /clear to take effect.");
    expect(read(join(cwd, ".mcp.json")).mcpServers.gh.disabled).toBe(true);
  });

  it("resolves user scope when the name is user-only", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand(["disable", "docs"], cwd, userPath);
    expect(result.stdout).toBe("Disabled docs (user). Restart or /clear to take effect.");
    expect(read(userPath).mcpServers.docs.disabled).toBe(true);
  });

  it("honors --scope and reports unknown names", () => {
    const { cwd, userPath } = setup();
    writeFileSync(userPath, JSON.stringify({ mcpServers: { gh: { command: "u" } } }));
    const scoped = runMcpCommand(["disable", "gh", "--scope", "user"], cwd, userPath);
    expect(scoped.stdout).toContain("Disabled gh (user).");
    const missing = runMcpCommand(["disable", "ghost"], cwd, userPath);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('No MCP server named "ghost".');
  });

  it("is idempotent and rejects bad usage", () => {
    const { cwd, userPath } = setup();
    runMcpCommand(["disable", "gh"], cwd, userPath);
    const again = runMcpCommand(["disable", "gh"], cwd, userPath);
    expect(again.stdout).toContain("already disabled");
    const bad = runMcpCommand(["disable"], cwd, userPath);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain("Usage: cloudcode mcp [disable|enable <name>]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliMcp.test.ts`
Expected: FAIL with "Failed to resolve import ... mcp.js" (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/cli/mcp.ts`:

```ts
import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import {
  isMcpServerDisabled,
  loadMcpServersByScope,
  resolveMcpServerScope,
  setMcpServerDisabled
} from "../../agent/mcp.js";
import { formatMcpList } from "./mcpList.js";

export interface McpCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const USAGE = "Usage: cloudcode mcp [disable|enable <name>] [--scope user|project]";

// Parse ["disable"|"enable", name, ("--scope", scope)?]. Returns undefined
// for the bare list form; throws Error(USAGE) on bad input.
function parseToggle(args: string[]): { enable: boolean; name: string; scope?: "user" | "project" } | undefined {
  if (args.length === 0) return undefined;
  const [action, name, flag, scope] = args;
  if ((action !== "disable" && action !== "enable") || !name) throw new Error(USAGE);
  if (flag === undefined) return { enable: action === "enable", name };
  if (flag !== "--scope" || (scope !== "user" && scope !== "project")) throw new Error(USAGE);
  if (args.length !== 4) throw new Error(USAGE);
  return { enable: action === "enable", name, scope };
}

export function runMcpCommand(
  args: string[],
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): McpCommandResult {
  let toggle: { enable: boolean; name: string; scope?: "user" | "project" } | undefined;
  try {
    toggle = parseToggle(args);
  } catch (err) {
    return { exitCode: 1, stdout: err instanceof Error ? err.message : USAGE };
  }
  if (!toggle) return { exitCode: 0, stdout: formatMcpList(loadMcpServersByScope(cwd, userPath)) };
  const scope = toggle.scope ?? resolveMcpServerScope(toggle.name, cwd, userPath);
  if (!scope) return { exitCode: 1, stdout: `No MCP server named "${toggle.name}".` };
  if (scope === "project" && toggle.name.startsWith("pack__")) {
    return { exitCode: 1, stdout: `Pack servers cannot be disabled (${toggle.name}).` };
  }
  const scopes = loadMcpServersByScope(cwd, userPath);
  const current = scopes[scope][toggle.name];
  if (current && isMcpServerDisabled(current) !== !toggle.enable) {
    // Already in the requested state: confirm without rewriting.
    const state = toggle.enable ? "enabled" : "disabled";
    return { exitCode: 0, stdout: `${toggle.name} is already ${state} (${scope}).` };
  }
  try {
    setMcpServerDisabled(toggle.name, !toggle.enable, scope, cwd, userPath);
  } catch (err) {
    return { exitCode: 1, stdout: err instanceof Error ? err.message : String(err) };
  }
  const verb = toggle.enable ? "Enabled" : "Disabled";
  return { exitCode: 0, stdout: `${verb} ${toggle.name} (${scope}). Restart or /clear to take effect.` };
}
```

In `src/cli.tsx`, replace the `case "mcp":` body:

```ts
    case "mcp": {
      const result = runMcpCommand(parsed.args, process.cwd());
      console.log(result.stdout ?? "");
      if (result.exitCode !== 0) process.exitCode = 1;
      break;
    }
```

and change the import to `import { runMcpCommand } from "./commands/cli/mcp.js";` (drop `formatMcpList`/`loadMcpServersByScope` imports).

In `src/cliArgs.ts`, update the Commands help block line to:

```ts
  mcp       List configured MCP servers (mcp disable|enable <name> [--scope user|project])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cliMcp.test.ts tests/mcpList.test.ts tests/cliArgs.test.ts`
Expected: PASS. Note: `tests/cliArgs.test.ts` asserts on `parseCli(["mcp", "--x"])` routing only, unaffected by help-text change.

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/cli/mcp.ts src/cli.tsx src/cliArgs.ts tests/cliMcp.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): add cloudcode mcp disable/enable subcommand"
```

---

### Task 4: `/mcp disable/enable` slash command

**Files:**
- Modify: `src/commands/types.ts`
- Modify: `src/commands/builtins.ts`
- Modify: `src/commands/completion.ts`
- Modify: `src/ui/nativeApp.ts`
- Test: `tests/commands.test.ts`
- Test: `tests/completion.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/commands.test.ts`, extend `mockCtx()` with:

```ts
mcpSetEnabled: vi.fn().mockResolvedValue("Disabled gh (project). Use /clear to reconnect."),
```

(this goes next to the existing `mcpStatus` mock), and extend the `/mcp` describe:

```ts
it("disables a server by name", async () => {
  const ctx = mockCtx();
  await buildRegistry().get("mcp")!.run(ctx, "disable gh");
  expect(ctx.mcpSetEnabled).toHaveBeenCalledWith("gh", false);
  expect(ctx.notice).toHaveBeenCalledWith("Disabled gh (project). Use /clear to reconnect.");
});

it("prints usage for bad args", async () => {
  const ctx = mockCtx();
  await buildRegistry().get("mcp")!.run(ctx, "disable");
  expect(ctx.notice).toHaveBeenCalledWith("Usage: /mcp [disable|enable <name>]");
  expect(ctx.mcpSetEnabled).not.toHaveBeenCalled();
});

it("completes subcommands then server names", () => {
  const cmd = buildRegistry().get("mcp")!;
  const cctx = { mcpServerNames: () => ["gh", "docs"] } as never;
  expect(cmd.completeArgs!("", cctx)).toEqual(["disable", "enable"]);
  expect(cmd.completeArgs!("d", cctx)).toEqual(["disable"]);
  expect(cmd.completeArgs!("disable ", cctx)).toEqual(["disable gh", "disable docs"]);
  expect(cmd.completeArgs!("disable g", cctx)).toEqual(["disable gh"]);
  expect(cmd.completeArgs!("enable d", cctx)).toEqual(["enable docs"]);
});

it("completes nothing for unknown actions or extra tokens", () => {
  const cmd = buildRegistry().get("mcp")!;
  const cctx = { mcpServerNames: () => ["gh"] } as never;
  expect(cmd.completeArgs!("bogus ", cctx)).toEqual([]);
  expect(cmd.completeArgs!("disable gh extra", cctx)).toEqual([]);
});
```

In `tests/completion.test.ts`, update the `ctx()` helper to include the new field:

```ts
function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: buildRegistry(),
    providerNames: () => ["anthropic", "local"],
    availableModels: () => [],
    mcpServerNames: () => [],
    listFiles: () => [],
    ...overrides
  };
}
```

and add to the `argument provider` describe:

```ts
it("suggests MCP server names after /mcp disable", () => {
  const s = getSuggestions("/mcp disable ", 13, ctx({ mcpServerNames: () => ["gh", "docs"] }));
  expect(s.map(x => x.value)).toEqual(["disable gh", "disable docs"]);
  expect(s[0]).toMatchObject({ replaceStart: 5, replaceEnd: 13 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts tests/completion.test.ts`
Expected: FAIL — `mcpSetEnabled` does not exist on `CommandContext` (type error) and `/mcp` ignores args so `mcpSetEnabled` is never called; `completeArgs("disable ")` returns `[]`; `mcpServerNames` does not exist on `CompletionContext`.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/completion.ts`, extend both interfaces and the factory:

```ts
export interface CompletionContext {
  registry: Map<string, Command>;
  providerNames(): string[];
  availableModels(): string[];
  mcpServerNames(): string[];
  listFiles(): string[];
  refreshFiles?(): void;
}

export interface LiveCompletionDependencies {
  registry(): Map<string, Command>;
  providerNames(): string[];
  availableModels(): string[];
  mcpServerNames(): string[];
  listFiles(): string[];
  refreshFiles(): void;
}

export function liveCompletionContext(deps: LiveCompletionDependencies): CompletionContext {
  return {
    get registry() { return deps.registry(); },
    providerNames: deps.providerNames,
    availableModels: deps.availableModels,
    mcpServerNames: deps.mcpServerNames,
    listFiles: deps.listFiles,
    refreshFiles: deps.refreshFiles
  };
}
```

In `src/commands/types.ts`, after `mcpStatus(): Promise<string>;` add:

```ts
  mcpSetEnabled(name: string, enabled: boolean): Promise<string>;
```

In `src/commands/builtins.ts`, replace the `mcp` command entry with:

```ts
  {
    name: "mcp",
    description: "Show MCP server status and tools; /mcp disable|enable <name>",
    async run(ctx, args) {
      const [action, name, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!action) { ctx.notice(await ctx.mcpStatus()); return; }
      if ((action !== "disable" && action !== "enable") || !name || rest.length > 0) {
        ctx.notice("Usage: /mcp [disable|enable <name>]");
        return;
      }
      ctx.notice(await ctx.mcpSetEnabled(name, action === "enable"));
    },
    completeArgs(prefix, cctx) {
      const trimmed = prefix.trimStart();
      if (!trimmed.includes(" ")) return ["disable", "enable"].filter(s => s.startsWith(trimmed));
      const [action, frag = "", ...rest] = trimmed.split(/\s+/);
      if ((action !== "disable" && action !== "enable") || rest.length > 0) return [];
      const names = cctx.mcpServerNames();
      return names.filter(n => n.startsWith(frag)).map(n => `${action} ${n}`);
    }
  },
```

Note: completion returns `"<action> <name>"` (not bare names) because `argumentSuggestions` in `src/commands/completion.ts` replaces the whole args region — same convention as `/config` (`theme mono`). The `trimStart()` keeps the existing subcommand-prefix behavior; name filtering is prefix-only (`startsWith`), matching `/model` and `/provider`.

In `src/ui/nativeApp.ts`:

1. Update the import: `import { loadMcpServers, loadMcpServersByScope, isMcpServerDisabled, resolveMcpServerScope, setMcpServerDisabled, formatMcpStatus } from "../agent/mcp.js";`
2. Add a field next to `private mcpServers`: `private mcpDisabled = new Set<string>();`
3. In the `liveCompletionContext({...})` constructor call in the `App` constructor, add the names provider alongside `availableModels` (union with dedup so disabled names stay completable for `/mcp enable`):

```ts
    this.completionCtx = liveCompletionContext({
      registry: () => this.registry, providerNames: () => Object.keys(this.props.providers),
      availableModels: () => this.availableModels,
      mcpServerNames: () => Array.from(new Set([...Object.keys(this.mcpServers), ...this.mcpDisabled])),
      listFiles: () => this.fileIndex.list(),
      refreshFiles: () => this.fileIndex.refresh()
    });
```

4. In `createSession`, after computing `this.mcpServers`, compute the disabled set from the scope files. Trust filtering (`allowProjectConfig`) applies in `loadMcpServers`, not in the scope loader, so hide project entries when trust is off:

```ts
    const scopes = loadMcpServersByScope(this.props.cwd);
    const visible = this.allowProjectConfig ? scopes : { user: scopes.user, project: {} };
    this.mcpDisabled = new Set(
      Object.keys({ ...visible.user, ...visible.project }).filter(name => {
        const effective = visible.project[name] ?? visible.user[name];
        return effective ? isMcpServerDisabled(effective) : false;
      })
    );
```

5. Update the context implementation:

```ts
      mcpStatus: async () =>
        formatMcpStatus(
          [...Object.keys(this.mcpServers), ...this.mcpDisabled],
          (await this.session?.mcpStatus()) ?? [],
          this.session?.tools ?? [],
          this.mcpDisabled
        ),
      mcpSetEnabled: async (name, enabled) => {
        const scope = resolveMcpServerScope(name, this.props.cwd);
        if (!scope) return `No MCP server named "${name}".`;
        if (name.startsWith("pack__")) return `Pack servers cannot be disabled (${name}).`;
        try {
          setMcpServerDisabled(name, !enabled, scope, this.props.cwd);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        if (enabled) this.mcpDisabled.delete(name);
        else this.mcpDisabled.add(name);
        const verb = enabled ? "Enabled" : "Disabled";
        return `${verb} ${name} (${scope}). Use /clear to reconnect.`;
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts tests/mcp.test.ts tests/app.test.ts`
Expected: PASS. (`tests/app.test.ts` mocks `../src/agent/mcp.js` with `importActual` spread, so the new helpers survive the mock; the `/mcp renders its output` test still passes because `mcpDisabled` is empty in that fixture.)

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/types.ts src/commands/builtins.ts src/ui/nativeApp.ts tests/commands.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(tui): add /mcp disable/enable slash command"
```

---

### Task 5: Setup wizard disable/enable actions

**Files:**
- Modify: `src/commands/cli/setup.ts`
- Test: `tests/cliSetup.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/cliSetup.test.ts`, add to the `runSetupCommand mcp section` describe:

```ts
it("disables and re-enables a server by number", async () => {
  const { deps, cwd } = scriptDeps([
    "", "",
    "",
    "disable", "1", "enable", "1", "done",
    "done",
    "", "", ""
  ]);
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx" } } }));
  await runSetupCommand([], deps);
  expect(readJson(join(cwd, ".mcp.json")).mcpServers.gh).toEqual({ command: "npx" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliSetup.test.ts`
Expected: FAIL — the wizard prints "Choose add, remove, or done." and never touches the flag, so the prompt script desyncs (throws "prompt script exhausted") or the flag stays unset.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/cli/setup.ts`, update the import:

```ts
import { loadMcpServersByScope, saveMcpServer, removeMcpServer, setMcpServerDisabled, isMcpServerDisabled, type McpServerConfig } from "../../agent/mcp.js";
```

In `configureMcp`, change the prompt and branch:

```ts
    const action = (await prompt("add/remove/disable/enable/done: ")).trim().toLowerCase();
```

Add after the `remove` branch, before the final `else`:

```ts
    } else if (action === "disable" || action === "enable") {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cliSetup.test.ts tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/bump-version.mjs
git add src/commands/cli/setup.ts tests/cliSetup.test.ts package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "feat(cli): setup wizard MCP disable/enable actions"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run lint and size checks**

Run: `npm run lint; npm run lint:size`
Expected: no errors; no file over ~600 lines warns on touched files (`src/commands/cli/mcp.ts` new ~90 lines; `src/agent/mcp.ts` ~200 lines; `src/commands/cli/setup.ts` ~230 lines).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites PASS, including `tests/packaging.test.ts` (version agreement across `package.json` / `package-lock.json` / `src/version.ts` / `installer/cloudcode.iss`).

- [ ] **Step 3: Manual smoke test**

Run: `npm run build`
Expected: `tsc` succeeds with no type errors (catches e.g. `CommandContext` implementers missing `mcpSetEnabled`, or the `formatMcpStatus` 4th-arg call sites).

Then in a temp dir:

```bash
node dist/cli.js mcp
node dist/cli.js mcp disable gh
node dist/cli.js mcp enable gh --scope project
```

Expected: list output, `Disabled gh (project). ...`, `Enabled gh (project). ...` with matching `.mcp.json` flag changes.
