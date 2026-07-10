# MCP Server Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load MCP server configs from `.mcp.json` (project) and `~/.cloudcode/mcp.json` (user), pass them to the Agent SDK session, and add an `/mcp` status command.

**Architecture:** Pure config passthrough — a loader in `src/agent/mcp.ts` merges the two config files into the SDK's `mcpServers` option; `AgentSession` forwards it to `query()` and exposes `mcpStatus()` (wrapping the SDK query's `mcpServerStatus()`) plus the tool list from the init message; a pure `formatMcpStatus` renders the `/mcp` output; App wires it into `CommandContext.mcpStatus()`.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, Ink, vitest. ESM imports use `.js` extensions.

## Global Constraints

- All code, comments, and identifiers in English only.
- Config errors are tolerated silently (same as `loadProviders`): a missing or malformed file contributes no servers.
- A failing MCP server must never block startup; failures only show in `/mcp` output.
- Run tests with `npx vitest run <file>`; run `npx tsc --noEmit` before finishing integration.

---

### Task 1: Config loader and status formatter — `src/agent/mcp.ts`

**Files:**
- Create: `src/agent/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.ts`.
- Produces (used by Tasks 2 and 3):

```ts
export type McpServerConfig = Record<string, unknown>; // passed through to the SDK unmodified

export interface McpServerStatusEntry {
  name: string;
  status: string; // "connected" | "failed" | "pending" | whatever the SDK reports
}

export function loadMcpServers(cwd: string, userPath?: string): Record<string, McpServerConfig>;
// userPath defaults to join(configDir(), "mcp.json")

export function formatMcpStatus(
  configured: string[],
  statuses: McpServerStatusEntry[],
  tools: string[] // full tool names from the init message, e.g. "mcp__github__create_issue"
): string;
```

Note: we deliberately do NOT import an `McpServerConfig` type from the SDK — entries are passed through untyped, and the SDK validates per server at connect time. `Record<string, unknown>` is structurally assignable to the SDK's `mcpServers` option value (cast at the single passthrough point in Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/mcp.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, formatMcpStatus } from "../src/agent/mcp.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-mcp-"));
}

describe("loadMcpServers", () => {
  it("loads project .mcp.json", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
    const servers = loadMcpServers(cwd, join(tempDir(), "mcp.json"));
    expect(servers).toEqual({ github: { command: "npx" } });
  });

  it("loads user config and lets project entries win on conflict", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://u" }, github: { command: "user" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "project" } } }));
    const servers = loadMcpServers(cwd, userFile);
    expect(servers).toEqual({ docs: { type: "http", url: "https://u" }, github: { command: "project" } });
  });

  it("returns {} for missing files", () => {
    expect(loadMcpServers(tempDir(), join(tempDir(), "mcp.json"))).toEqual({});
  });

  it("tolerates malformed JSON and wrong-shape mcpServers", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".mcp.json"), "{not json");
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: "nope" }));
    expect(loadMcpServers(cwd, userFile)).toEqual({});
  });
});

describe("formatMcpStatus", () => {
  it("reports no servers configured", () => {
    expect(formatMcpStatus([], [], [])).toBe(
      "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json."
    );
  });

  it("lists each server with status and its tools", () => {
    const out = formatMcpStatus(
      ["github", "docs"],
      [{ name: "github", status: "connected" }, { name: "docs", status: "failed" }],
      ["mcp__github__create_issue", "mcp__github__get_repo", "Bash"]
    );
    expect(out).toBe("github  connected  tools: create_issue, get_repo\ndocs  failed");
  });

  it("shows pending for configured servers missing from the status list", () => {
    expect(formatMcpStatus(["github"], [], [])).toBe("github  pending");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL — cannot resolve `../src/agent/mcp.js`.

- [ ] **Step 3: Implement**

```ts
// src/agent/mcp.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";

export type McpServerConfig = Record<string, unknown>;

export interface McpServerStatusEntry {
  name: string;
  status: string;
}

function readServerFile(filePath: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const servers = raw?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, McpServerConfig>;
    }
  } catch {
    // missing or invalid file: contributes no servers
  }
  return {};
}

export function loadMcpServers(
  cwd: string,
  userPath: string = join(configDir(), "mcp.json")
): Record<string, McpServerConfig> {
  const user = readServerFile(userPath);
  const project = readServerFile(join(cwd, ".mcp.json"));
  return { ...user, ...project };
}

export function formatMcpStatus(
  configured: string[],
  statuses: McpServerStatusEntry[],
  tools: string[]
): string {
  if (configured.length === 0) {
    return "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json.";
  }
  const statusByName = new Map(statuses.map(s => [s.name, s.status]));
  return configured
    .map(name => {
      const status = statusByName.get(name) ?? "pending";
      const prefix = `mcp__${name}__`;
      const serverTools = tools.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length));
      const toolsPart = serverTools.length > 0 ? `  tools: ${serverTools.join(", ")}` : "";
      return `${name}  ${status}${toolsPart}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp.ts tests/mcp.test.ts
git commit -m "feat: MCP config loader and status formatter"
```

---

### Task 2: Session wiring — pass mcpServers, capture tools, expose mcpStatus

**Files:**
- Modify: `src/agent/session.ts`
- Test: `tests/session.test.ts` (append)

**Interfaces:**
- Consumes: `McpServerConfig`, `McpServerStatusEntry` from `src/agent/mcp.ts` (Task 1).
- Produces (used by Task 3):
  - `AgentSessionOptions.mcpServers?: Record<string, McpServerConfig>`
  - `AgentSession.tools: string[]` — tool names from the SDK init message (empty until init).
  - `AgentSession.mcpStatus(): Promise<McpServerStatusEntry[]>` — `[]` when the query is missing, lacks `mcpServerStatus`, or throws.

- [ ] **Step 1: Write the failing tests** (append to `tests/session.test.ts`; the existing `fakeQuery` helper and `AgentSession` import are already in the file)

```ts
describe("AgentSession MCP", () => {
  it("passes mcpServers into query options and captures init tools", async () => {
    let seenOptions: Record<string, unknown> = {};
    const queryFn = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      seenOptions = args.options;
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1", tools: ["Bash", "mcp__github__get_repo"] };
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      mcpServers: { github: { command: "npx" } },
      onMessage: () => {},
      onPermissionRequest: () => {},
      onSessionId: () => {},
      queryFn: queryFn as never
    });
    session.start();
    await vi.waitFor(() => expect(session.tools).toEqual(["Bash", "mcp__github__get_repo"]));
    expect(seenOptions.mcpServers).toEqual({ github: { command: "npx" } });
    await session.dispose();
  });

  it("mcpStatus returns SDK statuses, and [] when unsupported", async () => {
    const statuses = [{ name: "github", status: "connected" }];
    const withStatus = () => {
      const gen = (async function* () {})();
      return Object.assign(gen, {
        interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn(),
        mcpServerStatus: vi.fn().mockResolvedValue(statuses)
      });
    };
    const s1 = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "default", cwd: "/p",
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {},
      queryFn: withStatus as never
    });
    s1.start();
    expect(await s1.mcpStatus()).toEqual(statuses);
    await s1.dispose();

    const without = () => {
      const gen = (async function* () {})();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const s2 = new AgentSession({
      providerName: "anthropic", provider: {}, permissionMode: "default", cwd: "/p",
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {},
      queryFn: without as never
    });
    s2.start();
    expect(await s2.mcpStatus()).toEqual([]);
    await s2.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: the two new tests FAIL (unknown option / missing members); the three existing tests still pass.

- [ ] **Step 3: Implement** in `src/agent/session.ts`:

Add the import:

```ts
import type { McpServerConfig, McpServerStatusEntry } from "./mcp.js";
```

Add to `AgentSessionOptions`:

```ts
  mcpServers?: Record<string, McpServerConfig>;
```

Add a public field to `AgentSession` (next to `sessionId`):

```ts
  tools: string[] = [];
```

In `start()`, add to the `options` object passed to `queryFn` (next to `cwd`):

```ts
        mcpServers: this.opts.mcpServers as never,
```

(The cast crosses from our untyped passthrough config to the SDK's union type; the SDK validates entries at connect time.)

In `pump()`, inside the existing init-message branch (after `this.opts.onSessionId(...)`):

```ts
          this.tools = (msg as { tools?: string[] }).tools ?? [];
```

Add the method (next to `setPermissionMode`):

```ts
  async mcpStatus(): Promise<McpServerStatusEntry[]> {
    try {
      const q = this.q as unknown as { mcpServerStatus?: () => Promise<McpServerStatusEntry[]> } | undefined;
      return q?.mcpServerStatus ? await q.mcpServerStatus() : [];
    } catch {
      return [];
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts tests/session.test.ts
git commit -m "feat: pass mcpServers to SDK session and expose mcpStatus"
```

---

### Task 3: /mcp command and App wiring

**Files:**
- Modify: `src/commands/types.ts` (add `mcpStatus` to `CommandContext`)
- Modify: `src/commands/builtins.ts` (add `/mcp` command)
- Modify: `src/ui/App.tsx` (load config into sessions, implement `ctx.mcpStatus`)
- Test: `tests/commands.test.ts` (append; also update `mockCtx`)

**Interfaces:**
- Consumes: `loadMcpServers`, `formatMcpStatus` (Task 1); `AgentSessionOptions.mcpServers`, `AgentSession.tools`, `AgentSession.mcpStatus()` (Task 2).
- Produces: `CommandContext.mcpStatus(): Promise<string>` — returns the fully formatted status text.

- [ ] **Step 1: Write the failing test** (append to `tests/commands.test.ts`)

```ts
describe("/mcp", () => {
  it("prints the formatted MCP status", async () => {
    const ctx = mockCtx();
    const registry = buildRegistry();
    await registry.get("mcp")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("github  connected  tools: get_repo");
  });
});
```

And add to the object returned by `mockCtx()` in the same file:

```ts
    mcpStatus: vi.fn().mockResolvedValue("github  connected  tools: get_repo"),
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands.test.ts`
Expected: the new test FAILS (`registry.get("mcp")` is undefined). A TypeScript error on the extra `mockCtx` key is also acceptable at this stage.

- [ ] **Step 3: Implement**

In `src/commands/types.ts`, add to `CommandContext`:

```ts
  mcpStatus(): Promise<string>;
```

In `src/commands/builtins.ts`, add to the `commands` array (before the `exit` entry):

```ts
  {
    name: "mcp",
    description: "Show MCP server status and tools",
    async run(ctx) { ctx.notice(await ctx.mcpStatus()); }
  },
```

In `src/ui/App.tsx`:

Add imports:

```tsx
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
```

Add a ref near `fileIndexRef` (line ~56):

```tsx
  const mcpServersRef = useRef<Record<string, Record<string, unknown>>>({});
```

In `createSession`, load config first and pass it (the load runs on every session construction — startup, `/clear`, provider switch, resume — so config edits are picked up by `/clear`):

```tsx
  function createSession(name: string, resume?: string): AgentSession {
    mcpServersRef.current = loadMcpServers(props.cwd);
    const session = new AgentSession({
      // ...existing options unchanged...
      mcpServers: mcpServersRef.current,
```

Add to the `ctx: CommandContext` object (after `clearPermissionRules`):

```tsx
    mcpStatus: async () =>
      formatMcpStatus(
        Object.keys(mcpServersRef.current),
        (await sessionRef.current?.mcpStatus()) ?? [],
        sessionRef.current?.tools ?? []
      ),
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors. If `tests/app.test.tsx` builds a `CommandContext` or asserts on the registry size, update it consistently (add the `mcpStatus` mock the same way as in `commands.test.ts`).

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts src/ui/App.tsx tests/commands.test.ts
git commit -m "feat: /mcp command with server status and tool listing"
```
