# CLI Flags, Print Mode, and Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `cloudcode` binary `-h/--help`, short flags, a non-interactive print mode (`-p`), friendly unknown-flag errors, and four subcommands (`doctor`, `config`, `mcp`, `update`).

**Architecture:** A pure `parseCli(argv)` function in `src/cliArgs.ts` returns a discriminated union; `src/cli.tsx` dispatches on it. Subcommands are small pure modules under `src/commands/cli/`. Print mode (`src/printMode.ts`) reuses the existing UI-independent `AgentSession` with a headless message handler. No new dependencies.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:util` parseArgs, vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-cli-commands-design.md`

## Global Constraints

- ALL code, comments, names, and output text in English only.
- No new runtime dependencies (keep exactly: @anthropic-ai/sdk, @modelcontextprotocol/sdk, marked, marked-terminal).
- Node >= 18; imports use `.js` extensions (ESM, `"type": "module"`).
- CLI output uses plain ASCII (no emoji/unicode glyphs) so it renders on any Windows console.
- Tests: vitest, files under `tests/*.test.ts`, run with `npx vitest run <file>`.

---

### Task 1: `parseCli` and help text

**Files:**
- Create: `src/cliArgs.ts`
- Test: `tests/cliArgs.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` type from `src/agent/session.js`.
- Produces: `parseCli(argv: string[]): CliResult`, `HELP_TEXT: string`, `SUBCOMMANDS`, and the `CliResult` union — Task 7 dispatches on `CliResult.kind` (`"help" | "version" | "error" | "subcommand" | "print" | "interactive"`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/cliArgs.test.ts
import { describe, it, expect } from "vitest";
import { parseCli, HELP_TEXT } from "../src/cliArgs.js";

describe("parseCli", () => {
  it("defaults to interactive", () => {
    expect(parseCli([])).toEqual({ kind: "interactive", continue: false, resume: false, provider: undefined });
  });

  it("parses help and version, long and short", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["-h"])).toEqual({ kind: "help" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
    expect(parseCli(["-v"])).toEqual({ kind: "version" });
  });

  it("parses continue/resume/provider", () => {
    expect(parseCli(["-c"])).toMatchObject({ kind: "interactive", continue: true });
    expect(parseCli(["-r"])).toMatchObject({ kind: "interactive", resume: true });
    expect(parseCli(["--provider", "local"])).toMatchObject({ kind: "interactive", provider: "local" });
  });

  it("detects subcommands and passes remaining args", () => {
    expect(parseCli(["doctor"])).toEqual({ kind: "subcommand", name: "doctor", args: [] });
    expect(parseCli(["mcp", "--x"])).toEqual({ kind: "subcommand", name: "mcp", args: ["--x"] });
  });

  it("rejects an unknown bare word", () => {
    const r = parseCli(["frobnicate"]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("Unknown command");
  });

  it("errors on unknown flags with a one-line message", () => {
    const r = parseCli(["--bogus"]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("--help");
  });

  it("parses print mode with a positional prompt", () => {
    expect(parseCli(["-p", "fix it"])).toEqual({
      kind: "print", prompt: "fix it", continue: false, provider: undefined, permissionMode: "default"
    });
  });

  it("parses print mode without a prompt (stdin case)", () => {
    expect(parseCli(["-p"])).toMatchObject({ kind: "print", prompt: undefined });
  });

  it("accepts a valid --permission-mode with print", () => {
    expect(parseCli(["-p", "x", "--permission-mode", "acceptEdits"]))
      .toMatchObject({ kind: "print", permissionMode: "acceptEdits" });
  });

  it("rejects an invalid --permission-mode", () => {
    expect(parseCli(["-p", "x", "--permission-mode", "yolo"]).kind).toBe("error");
  });

  it("rejects --permission-mode without --print", () => {
    expect(parseCli(["--permission-mode", "acceptEdits"]).kind).toBe("error");
  });

  it("rejects --resume with --print", () => {
    expect(parseCli(["-p", "x", "-r"]).kind).toBe("error");
  });

  it("rejects positionals in interactive mode and extras in print mode", () => {
    expect(parseCli(["-c", "stray"]).kind).toBe("error");
    expect(parseCli(["-p", "one", "two"]).kind).toBe("error");
  });
});

describe("HELP_TEXT", () => {
  it("mentions every flag and subcommand", () => {
    for (const s of ["--help", "--version", "--continue", "--resume", "--print",
      "--provider", "--permission-mode", "doctor", "config", "mcp", "update"]) {
      expect(HELP_TEXT).toContain(s);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL — cannot resolve `../src/cliArgs.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/cliArgs.ts
import { parseArgs } from "node:util";
import type { PermissionMode } from "./agent/session.js";

export const SUBCOMMANDS = ["doctor", "config", "mcp", "update"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type CliResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | { kind: "subcommand"; name: Subcommand; args: string[] }
  | { kind: "interactive"; continue: boolean; resume: boolean; provider?: string }
  | { kind: "print"; prompt?: string; continue: boolean; provider?: string; permissionMode: PermissionMode };

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

export const HELP_TEXT = `cloudcode - terminal AI coding agent

Usage:
  cloudcode [options]              Start an interactive session
  cloudcode -p [prompt] [options]  Run one prompt non-interactively and exit
  cloudcode <command>

Commands:
  doctor    Check environment and configuration health
  config    Show config file paths and effective settings
  mcp       List configured MCP servers
  update    Update cloudcode to the latest version

Options:
  -c, --continue                Resume the most recent session for this directory
  -r, --resume                  Open the session picker on start
      --provider <name>         Use a provider from ~/.cloudcode/providers.json
  -p, --print [prompt]          Non-interactive mode; prompt as argument or on stdin
      --permission-mode <mode>  default | acceptEdits | bypassPermissions (with -p only)
  -v, --version                 Print version and exit
  -h, --help                    Show this help`;

export function parseCli(argv: string[]): CliResult {
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if ((SUBCOMMANDS as readonly string[]).includes(first)) {
      return { kind: "subcommand", name: first as Subcommand, args: argv.slice(1) };
    }
    return { kind: "error", message: `Unknown command "${first}". Run cloudcode --help for usage.` };
  }
  let values: {
    help: boolean; version: boolean; continue: boolean; resume: boolean; print: boolean;
    provider?: string; "permission-mode"?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        continue: { type: "boolean", short: "c", default: false },
        resume: { type: "boolean", short: "r", default: false },
        print: { type: "boolean", short: "p", default: false },
        provider: { type: "string" },
        "permission-mode": { type: "string" }
      }
    }));
  } catch (err) {
    // parseArgs error messages run several sentences; keep only the first.
    const msg = (err instanceof Error ? err.message : String(err)).split(". ")[0];
    return { kind: "error", message: `${msg}. Run cloudcode --help for usage.` };
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const mode = values["permission-mode"];
  if (mode !== undefined && !values.print) {
    return { kind: "error", message: "--permission-mode is only valid with --print. Run cloudcode --help for usage." };
  }
  if (values.print) {
    if (mode !== undefined && !PERMISSION_MODES.includes(mode as PermissionMode)) {
      return { kind: "error", message: `Invalid --permission-mode "${mode}". Valid: ${PERMISSION_MODES.join(", ")}.` };
    }
    if (values.resume) {
      return { kind: "error", message: "--resume is not supported with --print; use --continue." };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: "Too many arguments: expected at most one prompt. Run cloudcode --help for usage." };
    }
    return {
      kind: "print",
      prompt: positionals[0],
      continue: values.continue,
      provider: values.provider,
      permissionMode: (mode as PermissionMode) ?? "default"
    };
  }
  if (positionals.length > 0) {
    return { kind: "error", message: `Unexpected argument "${positionals[0]}". Run cloudcode --help for usage.` };
  }
  return { kind: "interactive", continue: values.continue, resume: values.resume, provider: values.provider };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/cliArgs.ts tests/cliArgs.test.ts
git commit -m "feat(cli): add parseCli argument parser and help text"
```

---

### Task 2: `config` subcommand

**Files:**
- Create: `src/commands/cli/config.ts`
- Test: `tests/cliConfig.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.js`, `loadSettings(filePath)` from `src/agent/settings.js`.
- Produces: `configReport(dir?: string): string` — Task 7 prints it for `cloudcode config`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cliConfig.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configReport } from "../src/commands/cli/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "cliconfig-"));

describe("configReport", () => {
  it("shows defaults when no settings file exists", () => {
    const d = dir();
    const report = configReport(d);
    expect(report).toContain(join(d, "settings.json"));
    expect(report).toContain(join(d, "providers.json"));
    expect(report).toContain(join(d, "mcp.json"));
    expect(report).toContain("anthropic (default)");
    expect(report).toContain("permissionMode:  default");
  });

  it("shows saved settings", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({
      provider: "local", model: "claude-sonnet-5", permissionMode: "acceptEdits",
      effort: "high", theme: "light", autoMemoryEnabled: false
    }));
    const report = configReport(d);
    expect(report).toContain("provider:        local");
    expect(report).toContain("model:           claude-sonnet-5");
    expect(report).toContain("permissionMode:  acceptEdits");
    expect(report).toContain("effort:          high");
    expect(report).toContain("theme:           light");
    expect(report).toContain("autoMemory:      disabled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliConfig.test.ts`
Expected: FAIL — cannot resolve `../src/commands/cli/config.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/cli/config.ts
import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { loadSettings } from "../../agent/settings.js";

// Read-only report of config file locations and effective settings.
// The default model literal mirrors DEFAULT_MODEL in agent/session.ts.
export function configReport(dir: string = configDir()): string {
  const s = loadSettings(join(dir, "settings.json"));
  return [
    "Config files:",
    `  settings:  ${join(dir, "settings.json")}`,
    `  providers: ${join(dir, "providers.json")}`,
    `  mcp:       ${join(dir, "mcp.json")}`,
    "",
    "Effective settings:",
    `  provider:        ${s.provider ?? "anthropic (default)"}`,
    `  model:           ${s.model ?? "claude-sonnet-5 (default)"}`,
    `  permissionMode:  ${s.permissionMode ?? "default"}`,
    `  effort:          ${s.effort ?? "off"}`,
    `  theme:           ${s.theme ?? "dark (default)"}`,
    `  autoMemory:      ${s.autoMemoryEnabled === false ? "disabled" : "enabled"}`
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cliConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cli/config.ts tests/cliConfig.test.ts
git commit -m "feat(cli): add config subcommand report"
```

---

### Task 3: MCP scope-aware listing

**Files:**
- Modify: `src/agent/mcp.ts` (add `loadMcpServersByScope`; reimplement `loadMcpServers` on top of it)
- Create: `src/commands/cli/mcpList.ts`
- Test: `tests/mcpList.test.ts`

**Interfaces:**
- Consumes: `readServerFile` logic already inside `src/agent/mcp.ts` (private; stays private).
- Produces: `loadMcpServersByScope(cwd: string, userPath?: string): McpServersByScope` where `McpServersByScope = { user: Record<string, McpServerConfig>; project: Record<string, McpServerConfig> }`, and `formatMcpList(scopes: McpServersByScope): string` — Task 7 uses both for `cloudcode mcp`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcpList.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServersByScope, loadMcpServers } from "../src/agent/mcp.js";
import { formatMcpList } from "../src/commands/cli/mcpList.js";

const dir = () => mkdtempSync(join(tmpdir(), "mcplist-"));

describe("loadMcpServersByScope", () => {
  it("separates user and project servers", () => {
    const cwd = dir();
    const userPath = join(dir(), "mcp.json");
    writeFileSync(userPath, JSON.stringify({ mcpServers: { alpha: { command: "a" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { beta: { command: "b" } } }));
    const scopes = loadMcpServersByScope(cwd, userPath);
    expect(Object.keys(scopes.user)).toEqual(["alpha"]);
    expect(Object.keys(scopes.project)).toEqual(["beta"]);
  });

  it("keeps loadMcpServers merge semantics (project wins)", () => {
    const cwd = dir();
    const userPath = join(dir(), "mcp.json");
    writeFileSync(userPath, JSON.stringify({ mcpServers: { s: { command: "user" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "project" } } }));
    expect(loadMcpServers(cwd, userPath)).toEqual({ s: { command: "project" } });
  });
});

describe("formatMcpList", () => {
  it("reports empty configuration", () => {
    expect(formatMcpList({ user: {}, project: {} }))
      .toContain("No MCP servers configured");
  });

  it("annotates scopes and overrides", () => {
    const out = formatMcpList({
      user: { alpha: {}, shared: {} },
      project: { beta: {}, shared: {} }
    });
    expect(out).toContain("alpha  [user]");
    expect(out).toContain("beta  [project]");
    expect(out).toContain("shared  [project (overrides user)]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcpList.test.ts`
Expected: FAIL — `loadMcpServersByScope` is not exported / `mcpList.js` missing.

- [ ] **Step 3: Write the implementation**

In `src/agent/mcp.ts`, replace the existing `loadMcpServers` with:

```ts
export interface McpServersByScope {
  user: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
}

export function loadMcpServersByScope(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): McpServersByScope {
  return {
    user: readServerFile(userPath),
    project: readServerFile(join(cwd, ".mcp.json"))
  };
}

export function loadMcpServers(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): Record<string, McpServerConfig> {
  const scopes = loadMcpServersByScope(cwd, userPath);
  return { ...scopes.user, ...scopes.project };
}
```

Create `src/commands/cli/mcpList.ts`:

```ts
// src/commands/cli/mcpList.ts
import type { McpServersByScope } from "../../agent/mcp.js";

// Static listing for `cloudcode mcp`: which servers are configured and where.
// Deliberately does not connect to any server, so the command stays instant.
export function formatMcpList(scopes: McpServersByScope): string {
  const names = [...new Set([...Object.keys(scopes.user), ...Object.keys(scopes.project)])];
  if (names.length === 0) {
    return "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json.";
  }
  return names
    .map(name => {
      const inUser = name in scopes.user;
      const inProject = name in scopes.project;
      const scope = inProject && inUser ? "project (overrides user)" : inProject ? "project" : "user";
      return `${name}  [${scope}]`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass, including existing mcp tests**

Run: `npx vitest run tests/mcpList.test.ts tests/mcp.test.ts`
Expected: PASS — new tests and the existing `loadMcpServers` tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp.ts src/commands/cli/mcpList.ts tests/mcpList.test.ts
git commit -m "feat(cli): add scope-aware mcp listing"
```

---

### Task 4: `doctor` subcommand

**Files:**
- Create: `src/commands/cli/doctor.ts`
- Test: `tests/cliDoctor.test.ts`

**Interfaces:**
- Consumes: `loadProviders(filePath)`, `configDir()`, `ProviderConfig` from `src/agent/providers.js`.
- Produces: `runDoctor(opts?: { cwd?: string; dir?: string; env?: NodeJS.ProcessEnv }): DoctorCheck[]`, `formatDoctor(checks: DoctorCheck[]): string`, `DoctorCheck = { name: string; ok: boolean; detail: string }` — Task 7 prints the report and sets exit code 1 if any check fails.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cliDoctor.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNodeVersion, checkJsonFile, checkProviderKeys, runDoctor, formatDoctor
} from "../src/commands/cli/doctor.js";

const dir = () => mkdtempSync(join(tmpdir(), "doctor-"));

describe("doctor checks", () => {
  it("accepts node >= 18 and rejects older", () => {
    expect(checkNodeVersion("v22.1.0").ok).toBe(true);
    expect(checkNodeVersion("v16.20.0").ok).toBe(false);
  });

  it("treats a missing json file as ok and invalid json as a failure", () => {
    const d = dir();
    expect(checkJsonFile("providers.json", join(d, "nope.json")).ok).toBe(true);
    const bad = join(d, "bad.json");
    writeFileSync(bad, "not json{{");
    const check = checkJsonFile("providers.json", bad);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not valid JSON");
  });

  it("resolves anthropic keys from config or env, openai only from config", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test" };
    const checks = checkProviderKeys(
      { anthropic: {}, local: { kind: "openai", baseUrl: "http://x" } },
      env
    );
    expect(checks.find(c => c.name.includes("anthropic"))?.ok).toBe(true);
    expect(checks.find(c => c.name.includes("local"))?.ok).toBe(false);
  });

  it("runDoctor passes end to end on a healthy temp setup", () => {
    const d = dir();
    const checks = runDoctor({ dir: d, cwd: dir(), env: { ANTHROPIC_API_KEY: "sk-test" } });
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it("formatDoctor marks failures", () => {
    const out = formatDoctor([
      { name: "a", ok: true, detail: "fine" },
      { name: "b", ok: false, detail: "broken" }
    ]);
    expect(out).toContain("ok    a");
    expect(out).toContain("FAIL  b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliDoctor.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/cli/doctor.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadProviders, type ProviderConfig } from "../../agent/providers.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function checkNodeVersion(version: string = process.version): DoctorCheck {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return { name: "node version", ok: major >= 18, detail: `${version} (need >= 18)` };
}

export function checkConfigDirWritable(dir: string): DoctorCheck {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    return { name: "config dir writable", ok: true, detail: dir };
  } catch (err) {
    return {
      name: "config dir writable",
      ok: false,
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function checkJsonFile(name: string, filePath: string): DoctorCheck {
  if (!existsSync(filePath)) {
    return { name, ok: true, detail: `${filePath} (not present, defaults apply)` };
  }
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
    return { name, ok: true, detail: filePath };
  } catch {
    return { name, ok: false, detail: `${filePath} is not valid JSON` };
  }
}

// Anthropic-kind providers can fall back to the ANTHROPIC_API_KEY env var;
// openai-kind providers must carry an apiKey in providers.json.
export function checkProviderKeys(
  providers: Record<string, ProviderConfig>,
  env: NodeJS.ProcessEnv
): DoctorCheck[] {
  return Object.entries(providers).map(([name, cfg]) => {
    const isOpenai = cfg.kind === "openai";
    const key = cfg.apiKey ?? (isOpenai ? undefined : env.ANTHROPIC_API_KEY);
    return {
      name: `provider "${name}" api key`,
      ok: key !== undefined && key !== "",
      detail: key
        ? "configured"
        : isOpenai
          ? "missing apiKey in providers.json"
          : "set apiKey in providers.json or the ANTHROPIC_API_KEY env var"
    };
  });
}

export function runDoctor(
  opts: { cwd?: string; dir?: string; env?: NodeJS.ProcessEnv } = {}
): DoctorCheck[] {
  const dir = opts.dir ?? configDir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const providersPath = join(dir, "providers.json");
  return [
    checkNodeVersion(),
    checkConfigDirWritable(dir),
    checkJsonFile("providers.json", providersPath),
    ...checkProviderKeys(loadProviders(providersPath), env),
    checkJsonFile("user mcp.json", join(dir, "mcp.json")),
    checkJsonFile("project .mcp.json", join(cwd, ".mcp.json"))
  ];
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map(c => `${c.ok ? "ok  " : "FAIL"}  ${c.name}  ${c.detail}`)
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cliDoctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cli/doctor.ts tests/cliDoctor.test.ts
git commit -m "feat(cli): add doctor subcommand checks"
```

---

### Task 5: `update` subcommand

**Files:**
- Create: `src/commands/cli/update.ts`
- Test: `tests/cliUpdate.test.ts`

**Interfaces:**
- Consumes: `spawnSync` from `node:child_process`.
- Produces: `runUpdate(exec?: Exec, log?: (s: string) => void): number`, `isNpmGlobalInstall(npmLsOutput: string): boolean`, `UPDATE_INSTRUCTIONS: string`, `Exec = (args: string[], opts?: { inherit?: boolean }) => { stdout: string | null; status: number | null }` — Task 7 sets the process exit code from `runUpdate()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cliUpdate.test.ts
import { describe, it, expect } from "vitest";
import { isNpmGlobalInstall, runUpdate, UPDATE_INSTRUCTIONS, type Exec } from "../src/commands/cli/update.js";

describe("isNpmGlobalInstall", () => {
  it("detects a global npm install", () => {
    expect(isNpmGlobalInstall("/usr/lib\n`-- cloudcode@0.1.0\n")).toBe(true);
  });
  it("rejects empty npm ls output", () => {
    expect(isNpmGlobalInstall("/usr/lib\n`-- (empty)\n")).toBe(false);
    expect(isNpmGlobalInstall("")).toBe(false);
  });
});

describe("runUpdate", () => {
  it("prints instructions when not installed via npm", () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const exec: Exec = args => { calls.push(args); return { stdout: "`-- (empty)", status: 1 }; };
    expect(runUpdate(exec, s => logs.push(s))).toBe(0);
    expect(calls).toEqual([["ls", "-g", "cloudcode", "--depth=0"]]);
    expect(logs.join("\n")).toContain(UPDATE_INSTRUCTIONS);
  });

  it("runs npm install -g when installed via npm", () => {
    const calls: string[][] = [];
    const exec: Exec = args => {
      calls.push(args);
      return args[0] === "ls"
        ? { stdout: "`-- cloudcode@0.1.0", status: 0 }
        : { stdout: null, status: 0 };
    };
    expect(runUpdate(exec, () => {})).toBe(0);
    expect(calls[1]).toEqual(["install", "-g", "cloudcode@latest"]);
  });

  it("propagates npm install failure as exit 1", () => {
    const exec: Exec = args =>
      args[0] === "ls" ? { stdout: "`-- cloudcode@0.1.0", status: 0 } : { stdout: null, status: 3 };
    expect(runUpdate(exec, () => {})).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cliUpdate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/cli/update.ts
import { spawnSync } from "node:child_process";

export interface ExecResult {
  stdout: string | null;
  status: number | null;
}
export type Exec = (args: string[], opts?: { inherit?: boolean }) => ExecResult;

// npm is npm.cmd on Windows, which requires a shell to resolve.
const npmExec: Exec = (args, opts = {}) => {
  const res = spawnSync("npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: opts.inherit ? "inherit" : "pipe"
  });
  return { stdout: res.stdout ?? null, status: res.status };
};

export const UPDATE_INSTRUCTIONS = [
  "cloudcode does not appear to be installed via npm. Update options:",
  "  npm:        npm install -g cloudcode@latest",
  "  installer:  download the latest release from https://github.com/spider2449/cloudcode/releases",
  "  source:     git pull && npm install && npm run build"
].join("\n");

export function isNpmGlobalInstall(npmLsOutput: string): boolean {
  return /\bcloudcode@\d/.test(npmLsOutput);
}

export function runUpdate(exec: Exec = npmExec, log: (s: string) => void = console.log): number {
  const ls = exec(["ls", "-g", "cloudcode", "--depth=0"]);
  if (!isNpmGlobalInstall(ls.stdout ?? "")) {
    log(UPDATE_INSTRUCTIONS);
    return 0;
  }
  log("Updating: npm install -g cloudcode@latest");
  const res = exec(["install", "-g", "cloudcode@latest"], { inherit: true });
  return res.status === 0 ? 0 : 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cliUpdate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cli/update.ts tests/cliUpdate.test.ts
git commit -m "feat(cli): add update subcommand"
```

---

### Task 6: Print mode

**Files:**
- Create: `src/printMode.ts`
- Test: `tests/printMode.test.ts`

**Interfaces:**
- Consumes: `AgentSession`, `PermissionMode` from `src/agent/session.js`; `ProviderConfig` from `src/agent/providers.js`; `loadMcpServers` from `src/agent/mcp.js`; `EffortLevel` from `src/engine/effort.js`.
- Produces: `runPrint(opts: PrintOptions, io: PrintIo): Promise<number>` and `readStdin(stream?): Promise<string>` — Task 7 calls both. `PrintOptions = { prompt: string; providerName: string; provider: ProviderConfig; model?: string; effort?: EffortLevel; permissionMode: PermissionMode; resume?: string; cwd: string }`, `PrintIo = { out(text: string): void; err(text: string): void }`.

- [ ] **Step 1: Write the failing test**

Follows the `tests/session-integration.test.ts` pattern: mock `makeClient`, redirect HOME/USERPROFILE to a temp dir so `SessionFile` never touches the real `~/.cloudcode`.

```ts
// tests/printMode.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));

import { makeClient } from "../src/engine/api.js";
import { runPrint } from "../src/printMode.js";

type Event = Record<string, unknown>;

function fakeClient(turns: Event[][]) {
  let call = 0;
  return {
    create: vi.fn(async function* () {
      const events = turns[Math.min(call, turns.length - 1)];
      call++;
      for (const e of events) yield e;
    })
  };
}

function textTurn(text: string): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }
  ];
}

function toolTurn(name: string, input: Record<string, unknown>): Event[] {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }
  ];
}

function collectIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    outText: () => out.join(""),
    errText: () => err.join("")
  };
}

let home: string;
let saved: { HOME?: string; USERPROFILE?: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "print-home-"));
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

const baseOpts = () => ({
  prompt: "hi",
  providerName: "anthropic",
  provider: {},
  permissionMode: "default" as const,
  cwd: home
});

describe("runPrint", () => {
  it("streams assistant text to stdout and exits 0", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([textTurn("hello")]) as never);
    const { io, outText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(0);
    expect(outText()).toBe("hello\n");
  });

  it("auto-denies permission requests and reports the tool on stderr", async () => {
    vi.mocked(makeClient).mockReturnValue(
      fakeClient([toolTurn("Write", { file_path: join(home, "x.txt"), content: "x" }), textTurn("done")]) as never
    );
    const { io, errText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(0);
    expect(errText()).toContain("[denied] Write");
  });

  it("returns 1 and prints the error when the API fails", async () => {
    vi.mocked(makeClient).mockReturnValue({
      create: vi.fn(async function* () { throw new Error("boom"); })
    } as never);
    const { io, errText } = collectIo();
    const code = await runPrint(baseOpts(), io);
    expect(code).toBe(1);
    expect(errText()).toContain("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/printMode.test.ts`
Expected: FAIL — cannot resolve `../src/printMode.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/printMode.ts
import { AgentSession, type PermissionMode } from "./agent/session.js";
import type { ProviderConfig } from "./agent/providers.js";
import { loadMcpServers } from "./agent/mcp.js";
import type { EffortLevel } from "./engine/effort.js";

export interface PrintIo {
  out(text: string): void;
  err(text: string): void;
}

export interface PrintOptions {
  prompt: string;
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  resume?: string;
  cwd: string;
}

// One-shot non-interactive turn: stream assistant text to stdout, summarize
// tool activity on stderr, auto-deny anything that would prompt. The session
// file still persists exactly as in interactive mode.
export async function runPrint(opts: PrintOptions, io: PrintIo): Promise<number> {
  let exitCode = 0;
  let lastChar = "\n";
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const session = new AgentSession({
    providerName: opts.providerName,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    cwd: opts.cwd,
    mcpServers: loadMcpServers(opts.cwd),
    onMessage: msg => {
      if (msg.type === "stream_event") {
        if (msg.event.delta.type === "text_delta") {
          const text = msg.event.delta.text;
          if (text.length > 0) lastChar = text[text.length - 1];
          io.out(text);
        }
      } else if (msg.type === "assistant") {
        // Text was already streamed via deltas; only surface tool calls.
        for (const block of msg.message.content) {
          if (block.type === "tool_use") io.err(`[tool] ${block.name}\n`);
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "error_during_execution") {
          io.err(`${msg.result}\n`);
          exitCode = 1;
        }
        finish();
      }
    },
    onPermissionRequest: req => {
      io.err(`[denied] ${req.toolName} (non-interactive; pass --permission-mode acceptEdits or bypassPermissions to allow)\n`);
      req.resolve(false);
    },
    onSessionId: () => {}
  });
  session.start();
  session.send(opts.prompt);
  await done;
  // send() persists the transcript in a .then() that runs only after runTurn
  // resolves, which is after the result message that resolved `done`; yield
  // one macrotask so the session file is written before teardown.
  await new Promise(resolve => setImmediate(resolve));
  await session.dispose();
  if (lastChar !== "\n") io.out("\n");
  return exitCode;
}

export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/printMode.test.ts`
Expected: PASS (3 tests). If the denial test hangs, check that `onPermissionRequest` resolves synchronously — it must call `req.resolve(false)` immediately.

- [ ] **Step 5: Commit**

```bash
git add src/printMode.ts tests/printMode.test.ts
git commit -m "feat(cli): add non-interactive print mode"
```

---

### Task 7: Wire everything into `cli.tsx`

**Files:**
- Modify: `src/cli.tsx` (full replacement below)
- Test: manual smoke tests + full suite (cli.tsx is thin dispatch; the logic it calls is covered by Tasks 1-6)

**Interfaces:**
- Consumes: everything produced by Tasks 1-6, plus the existing `App`, `Terminal`, `loadProviders`, `loadSettings`, `SessionIndex`, `loadCustomThemes`, `VERSION`.
- Produces: the final CLI behavior; no exports.

- [ ] **Step 1: Replace `src/cli.tsx` with the dispatching version**

```tsx
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
      cwd: initialCwd
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
    // App.stop() (from /exit or double-Ctrl+C) only resolves run()'s promise;
    // it doesn't touch the process. A lingering handle elsewhere (e.g. a
    // keep-alive HTTP socket to the LLM API) would otherwise keep the event
    // loop alive and the process hanging until an external SIGINT forces it
    // down, same as the SIGINT handler above already does explicitly.
    process.exit(0);
  })();
}
```

Notes for the implementer:
- `process.exit()` with no argument honors any `process.exitCode` set in the subcommand branch.
- TypeScript narrows `parsed` correctly because every early branch ends in `process.exit(...)` (typed `never`).
- The mcp subcommand keeps the terse `--x` args unused for now; `parsed.args` is intentionally ignored by all four subcommands.

- [ ] **Step 2: Type-check and run the full suite**

Run: `npm run build && npm test`
Expected: build clean, all tests pass (including pre-existing suites).

- [ ] **Step 3: Manual smoke tests**

```bash
npx tsx src/cli.tsx --help          # usage text, exit 0
npx tsx src/cli.tsx -v              # "cloudcode 0.1.0"
npx tsx src/cli.tsx --bogus         # one-line error mentioning --help, exit 1, no stack trace
npx tsx src/cli.tsx frobnicate      # 'Unknown command "frobnicate"', exit 1
npx tsx src/cli.tsx config          # paths + effective settings
npx tsx src/cli.tsx doctor          # check list; exit code reflects failures
npx tsx src/cli.tsx mcp             # server list or "No MCP servers configured"
npx tsx src/cli.tsx update          # npm update or instructions
echo "say the word ok and nothing else" | npx tsx src/cli.tsx -p   # requires a valid API key
```

Expected: each behaves as annotated. Verify exit codes with `echo $?` (bash) or `$LASTEXITCODE` (PowerShell).

- [ ] **Step 4: Commit**

```bash
git add src/cli.tsx
git commit -m "feat(cli): wire help, print mode, and subcommands into the entry point"
```

---

### Task 8: README documentation

**Files:**
- Modify: `README.md` (add/extend a "CLI usage" section)

- [ ] **Step 1: Add a CLI usage section to README.md**

Insert after the installation section (adjust placement to the existing structure):

```markdown
## CLI usage

    cloudcode                 # interactive session
    cloudcode -c              # continue the latest session in this directory
    cloudcode -r              # pick a session to resume
    cloudcode -p "prompt"     # one-shot non-interactive run (or pipe the prompt on stdin)
    cloudcode doctor          # check environment and configuration health
    cloudcode config          # show config paths and effective settings
    cloudcode mcp             # list configured MCP servers
    cloudcode update          # update to the latest version

Print mode auto-denies any tool call that would normally prompt; pass
`--permission-mode acceptEdits` (or `bypassPermissions`) to loosen that for
a single run. Run `cloudcode --help` for the full flag list.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document CLI flags, print mode, and subcommands"
```
