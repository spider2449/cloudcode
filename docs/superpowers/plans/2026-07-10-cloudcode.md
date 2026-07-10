# cloudcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive terminal coding agent built on `@anthropic-ai/claude-agent-sdk` with an Ink TUI, slash commands, session resume, permission modes, and switchable providers including local llama.cpp.

**Architecture:** Three layers. Agent layer wraps one persistent SDK `query()` per session fed by an async-generator input stream. UI layer is Ink/React components driven by SDK message events. Command layer is a registry of slash-command modules. Providers work by restarting the session with `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/model overrides (llama.cpp's Anthropic-compatible endpoint).

**Tech Stack:** TypeScript (ESM), Node >= 18, `@anthropic-ai/claude-agent-sdk`, Ink 5 + React 18, tsx (dev), tsc (build), vitest + ink-testing-library (tests).

## Global Constraints

- ALL code, comments, docs, and identifiers in English only.
- ESM throughout (`"type": "module"`); relative imports use `.js` extension.
- Node >= 18.
- Spec: `docs/superpowers/specs/2026-07-10-cloudcode-design.md`.
- Config dir: `~/.cloudcode/` (`providers.json`, `sessions.json`).
- Permission modes exposed: `default`, `acceptEdits`, `bypassPermissions`.
- Slash commands in v1: `/help`, `/clear`, `/model`, `/permissions`, `/provider`, `/resume`, `/cost`, `/exit`.
- Out of scope: MCP, subagents, hooks, OpenAI-compat translation proxy.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/version.ts`, `tests/version.test.ts`

**Interfaces:**
- Produces: build/test toolchain; `VERSION` const (used by `/help` and CLI `--version`).

- [ ] **Step 1: Create package.json**

```json
{
  "name": "cloudcode",
  "version": "0.1.0",
  "type": "module",
  "bin": { "cloudcode": "dist/cli.js" },
  "engines": { "node": ">=18" },
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install @anthropic-ai/claude-agent-sdk ink@^5 react@^18
npm install -D typescript tsx vitest ink-testing-library @types/react @types/node
```
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create vitest.config.ts and .gitignore**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 5: Write failing test**

```ts
// tests/version.test.ts
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("exports a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

Run: `npx vitest run tests/version.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 6: Implement `src/version.ts`**

```ts
export const VERSION = "0.1.0";
```

Run: `npx vitest run tests/version.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript/Ink project"
```

---

### Task 2: Provider registry

**Files:**
- Create: `src/agent/providers.ts`
- Test: `tests/providers.test.ts`

**Interfaces:**
- Produces:
  - `interface ProviderConfig { baseUrl?: string; apiKey?: string; model?: string }`
  - `loadProviders(filePath?: string): Record<string, ProviderConfig>` — reads `~/.cloudcode/providers.json`; always includes an `anthropic: {}` default; missing/invalid file → just the default.
  - `providerEnv(cfg: ProviderConfig): Record<string, string>` — maps `baseUrl → ANTHROPIC_BASE_URL`, `apiKey → ANTHROPIC_API_KEY`; empty object for the default provider.
  - `configDir(): string` — `path.join(os.homedir(), ".cloudcode")`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/providers.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviders, providerEnv } from "../src/agent/providers.js";

describe("loadProviders", () => {
  it("returns anthropic default when file is missing", () => {
    const p = loadProviders(join(tmpdir(), "nope", "providers.json"));
    expect(p.anthropic).toEqual({});
  });

  it("merges file providers with default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({
      local: { baseUrl: "http://127.0.0.1:8080", apiKey: "none", model: "qwen2.5-coder-32b" }
    }));
    const p = loadProviders(file);
    expect(p.anthropic).toEqual({});
    expect(p.local.model).toBe("qwen2.5-coder-32b");
  });

  it("returns default on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, "{bad");
    expect(loadProviders(file)).toEqual({ anthropic: {} });
  });
});

describe("providerEnv", () => {
  it("maps baseUrl and apiKey to ANTHROPIC_* vars", () => {
    expect(providerEnv({ baseUrl: "http://x", apiKey: "k" })).toEqual({
      ANTHROPIC_BASE_URL: "http://x",
      ANTHROPIC_API_KEY: "k"
    });
  });

  it("returns empty object for empty config", () => {
    expect(providerEnv({})).toEqual({});
  });
});
```

Run: `npx vitest run tests/providers.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/agent/providers.ts`**

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function configDir(): string {
  return join(homedir(), ".cloudcode");
}

export function loadProviders(
  filePath: string = join(configDir(), "providers.json")
): Record<string, ProviderConfig> {
  const defaults: Record<string, ProviderConfig> = { anthropic: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (raw && typeof raw === "object") return { ...defaults, ...raw, anthropic: { ...raw.anthropic } };
  } catch {
    // missing or invalid file: fall through to defaults
  }
  return defaults;
}

export function providerEnv(cfg: ProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  if (cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  return env;
}
```

Run: `npx vitest run tests/providers.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/providers.ts tests/providers.test.ts
git commit -m "feat: provider registry with env-override mapping"
```

---

### Task 3: Session index

**Files:**
- Create: `src/agent/sessionIndex.ts`
- Test: `tests/sessionIndex.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.js`.
- Produces:
  - `interface SessionEntry { id: string; cwd: string; firstMessage: string; timestamp: string; provider: string }`
  - `class SessionIndex { constructor(filePath?: string); record(e: SessionEntry): void; list(): SessionEntry[]; latestForCwd(cwd: string): SessionEntry | undefined }`
  - `record` upserts by `id` and persists to disk immediately; `list()` is newest-first.

- [ ] **Step 1: Write failing tests**

```ts
// tests/sessionIndex.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/agent/sessionIndex.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json");
}

describe("SessionIndex", () => {
  it("records and lists newest-first, persisted across instances", () => {
    const file = tempFile();
    const a = new SessionIndex(file);
    a.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    a.record({ id: "s2", cwd: "/p", firstMessage: "yo", timestamp: "2026-07-10T02:00:00Z", provider: "local" });
    const b = new SessionIndex(file);
    expect(b.list().map(e => e.id)).toEqual(["s2", "s1"]);
  });

  it("upserts by id", () => {
    const idx = new SessionIndex(tempFile());
    idx.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    idx.record({ id: "s1", cwd: "/p", firstMessage: "hi", timestamp: "2026-07-10T03:00:00Z", provider: "anthropic" });
    expect(idx.list()).toHaveLength(1);
    expect(idx.list()[0].timestamp).toBe("2026-07-10T03:00:00Z");
  });

  it("finds latest for cwd", () => {
    const idx = new SessionIndex(tempFile());
    idx.record({ id: "s1", cwd: "/a", firstMessage: "x", timestamp: "2026-07-10T01:00:00Z", provider: "anthropic" });
    idx.record({ id: "s2", cwd: "/b", firstMessage: "y", timestamp: "2026-07-10T02:00:00Z", provider: "anthropic" });
    expect(idx.latestForCwd("/a")?.id).toBe("s1");
    expect(idx.latestForCwd("/c")).toBeUndefined();
  });
});
```

Run: `npx vitest run tests/sessionIndex.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/agent/sessionIndex.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

export interface SessionEntry {
  id: string;
  cwd: string;
  firstMessage: string;
  timestamp: string;
  provider: string;
}

export class SessionIndex {
  private entries: SessionEntry[] = [];

  constructor(private filePath: string = join(configDir(), "sessions.json")) {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.entries = raw;
    } catch {
      // missing or invalid file: start empty
    }
  }

  record(entry: SessionEntry): void {
    this.entries = this.entries.filter(e => e.id !== entry.id);
    this.entries.push(entry);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  list(): SessionEntry[] {
    return [...this.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  latestForCwd(cwd: string): SessionEntry | undefined {
    return this.list().find(e => e.cwd === cwd);
  }
}
```

Run: `npx vitest run tests/sessionIndex.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/sessionIndex.ts tests/sessionIndex.test.ts
git commit -m "feat: persistent session index"
```

---

### Task 4: Agent session wrapper

**Files:**
- Create: `src/agent/asyncQueue.ts`, `src/agent/session.ts`
- Test: `tests/asyncQueue.test.ts`, `tests/session.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `providerEnv` from `providers.js`.
- Produces:
  - `class AsyncQueue<T> { push(item: T): void; close(): void; [Symbol.asyncIterator](): AsyncIterator<T> }`
  - `type PermissionRequest = { toolName: string; input: Record<string, unknown>; resolve(allow: boolean): void }`
  - ```ts
    interface AgentSessionOptions {
      providerName: string;
      provider: ProviderConfig;
      model?: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions";
      resume?: string;
      cwd: string;
      onMessage(msg: SDKMessage): void;          // every SDK message
      onPermissionRequest(req: PermissionRequest): void;
      onSessionId(id: string): void;             // fired when system init message arrives
      queryFn?: typeof query;                     // injectable for tests
    }
    ```
  - `class AgentSession { constructor(opts: AgentSessionOptions); start(): void; send(text: string): void; async interrupt(): Promise<void>; async setModel(m: string): Promise<void>; async setPermissionMode(m: string): Promise<void>; async dispose(): Promise<void> }`
- Note for implementer: `query` comes from `@anthropic-ai/claude-agent-sdk`; check `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for the exact `Options` fields (`model`, `permissionMode`, `resume`, `cwd`, `env`, `canUseTool`) and `SDKMessage` union before implementing — adjust field names to match the installed version.

- [ ] **Step 1: Write failing AsyncQueue test**

```ts
// tests/asyncQueue.test.ts
import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../src/agent/asyncQueue.js";

describe("AsyncQueue", () => {
  it("yields pushed items in order and ends on close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    setTimeout(() => { q.push(3); q.close(); }, 10);
    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });
});
```

Run: `npx vitest run tests/asyncQueue.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `src/agent/asyncQueue.ts`**

```ts
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      }
    };
  }
}
```

Run: `npx vitest run tests/asyncQueue.test.ts` — Expected: PASS.

- [ ] **Step 3: Write failing session test (mocked SDK)**

```ts
// tests/session.test.ts
import { describe, it, expect, vi } from "vitest";
import { AgentSession } from "../src/agent/session.js";

function fakeQuery(received: unknown[]) {
  // Mimics the SDK: consumes the prompt stream, echoes canned messages.
  return (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const m of args.prompt) {
        received.push(m);
        yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
      }
    })();
    return Object.assign(gen, {
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn()
    });
  };
}

describe("AgentSession", () => {
  it("emits session id and forwards messages for sent text", async () => {
    const received: unknown[] = [];
    const messages: unknown[] = [];
    let sessionId = "";
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: m => messages.push(m),
      onPermissionRequest: () => {},
      onSessionId: id => { sessionId = id; },
      queryFn: fakeQuery(received) as never
    });
    session.start();
    session.send("hello");
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2));
    expect(sessionId).toBe("sess-1");
    expect((received[0] as { message: { content: string } }).message.content).toBe("hello");
    await session.dispose();
  });

  it("resolves canUseTool through onPermissionRequest", async () => {
    let captured: ((toolName: string, input: object) => Promise<unknown>) | undefined;
    const queryFn = (args: { options: { canUseTool: typeof captured } }) => {
      captured = args.options.canUseTool;
      const gen = (async function* () {})();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: () => {},
      onPermissionRequest: req => req.resolve(true),
      onSessionId: () => {},
      queryFn: queryFn as never
    });
    session.start();
    const result = await captured!("Bash", { command: "ls" });
    expect(result).toMatchObject({ behavior: "allow" });
    await session.dispose();
  });
});
```

Run: `npx vitest run tests/session.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement `src/agent/session.ts`**

```ts
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./asyncQueue.js";
import { providerEnv, type ProviderConfig } from "./providers.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  resolve(allow: boolean): void;
}

export interface AgentSessionOptions {
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  permissionMode: PermissionMode;
  resume?: string;
  cwd: string;
  onMessage(msg: SDKMessage): void;
  onPermissionRequest(req: PermissionRequest): void;
  onSessionId(id: string): void;
  queryFn?: typeof query;
}

export class AgentSession {
  private input = new AsyncQueue<SDKUserMessage>();
  private q: ReturnType<typeof query> | undefined;
  sessionId: string | undefined;

  constructor(private opts: AgentSessionOptions) {}

  start(): void {
    const queryFn = this.opts.queryFn ?? query;
    this.q = queryFn({
      prompt: this.input as AsyncIterable<SDKUserMessage>,
      options: {
        model: this.opts.model ?? this.opts.provider.model,
        permissionMode: this.opts.permissionMode,
        resume: this.opts.resume,
        cwd: this.opts.cwd,
        env: { ...process.env, ...providerEnv(this.opts.provider) } as Record<string, string>,
        canUseTool: (toolName, input) =>
          new Promise(resolvePermission => {
            this.opts.onPermissionRequest({
              toolName,
              input: input as Record<string, unknown>,
              resolve: allow =>
                resolvePermission(
                  allow
                    ? { behavior: "allow", updatedInput: input }
                    : { behavior: "deny", message: "User denied this tool use" }
                )
            });
          })
      }
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q!) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this.sessionId = (msg as { session_id: string }).session_id;
          this.opts.onSessionId(this.sessionId);
        }
        this.opts.onMessage(msg);
      }
    } catch (err) {
      this.opts.onMessage({
        type: "result",
        subtype: "error_during_execution",
        result: String(err)
      } as unknown as SDKMessage);
    }
  }

  send(text: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? ""
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  async dispose(): Promise<void> {
    this.input.close();
    await this.q?.interrupt().catch(() => {});
  }
}
```

Adjust type casts/field names to the installed SDK's `sdk.d.ts` if they differ.

Run: `npx vitest run tests/session.test.ts tests/asyncQueue.test.ts` — Expected: PASS. Also run `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent tests/asyncQueue.test.ts tests/session.test.ts
git commit -m "feat: persistent agent session wrapper over SDK query"
```

---

### Task 5: Command registry and built-in commands

**Files:**
- Create: `src/commands/types.ts`, `src/commands/registry.ts`, `src/commands/builtins.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` from `session.js`.
- Produces:
  - ```ts
    interface CommandContext {
      notice(text: string): void;                 // print a system notice in transcript
      clearSession(): Promise<void>;              // restart with fresh session
      setModel(model: string): Promise<void>;
      setPermissionMode(mode: PermissionMode): Promise<void>;
      switchProvider(name: string): Promise<void>;
      openResumePicker(): void;
      costSummary(): string;
      providerNames(): string[];
      exit(): void;
    }
    interface Command { name: string; description: string; run(ctx: CommandContext, args: string): Promise<void> }
    ```
  - `buildRegistry(): Map<string, Command>` (from `builtins.ts`)
  - `parseSlash(input: string): { name: string; args: string } | undefined` (from `registry.ts`) — returns undefined when input doesn't start with `/`.
  - `completions(registry: Map<string, Command>, prefix: string): string[]` — command names starting with prefix (without `/`).

- [ ] **Step 1: Write failing tests**

```ts
// tests/commands.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseSlash, completions } from "../src/commands/registry.js";
import { buildRegistry } from "../src/commands/builtins.js";
import type { CommandContext } from "../src/commands/types.js";

function mockCtx(): CommandContext {
  return {
    notice: vi.fn(),
    clearSession: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    openResumePicker: vi.fn(),
    costSummary: vi.fn().mockReturnValue("$0.01"),
    providerNames: vi.fn().mockReturnValue(["anthropic", "local"]),
    exit: vi.fn()
  };
}

describe("parseSlash", () => {
  it("parses name and args", () => {
    expect(parseSlash("/model claude-sonnet-5")).toEqual({ name: "model", args: "claude-sonnet-5" });
  });
  it("returns undefined for plain text", () => {
    expect(parseSlash("hello /world")).toBeUndefined();
  });
});

describe("builtins", () => {
  it("registers all v1 commands", () => {
    const names = [...buildRegistry().keys()].sort();
    expect(names).toEqual(["clear", "cost", "exit", "help", "model", "permissions", "provider", "resume"]);
  });

  it("/model with arg sets model; without arg notices usage", async () => {
    const reg = buildRegistry();
    const ctx = mockCtx();
    await reg.get("model")!.run(ctx, "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    await reg.get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("Usage: /model <model-name>");
  });

  it("/permissions rejects unknown mode", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "yolo");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("/provider switches provider", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("provider")!.run(ctx, "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
  });
});

describe("completions", () => {
  it("matches by prefix", () => {
    expect(completions(buildRegistry(), "pro")).toEqual(["provider"]);
    expect(completions(buildRegistry(), "c")).toEqual(["clear", "cost"]);
  });
});
```

Run: `npx vitest run tests/commands.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `src/commands/types.ts`**

```ts
import type { PermissionMode } from "../agent/session.js";

export interface CommandContext {
  notice(text: string): void;
  clearSession(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  switchProvider(name: string): Promise<void>;
  openResumePicker(): void;
  costSummary(): string;
  providerNames(): string[];
  exit(): void;
}

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext, args: string): Promise<void>;
}
```

- [ ] **Step 3: Implement `src/commands/registry.ts`**

```ts
import type { Command } from "./types.js";

export function parseSlash(input: string): { name: string; args: string } | undefined {
  const m = /^\/(\w+)\s*(.*)$/.exec(input.trim());
  if (!m) return undefined;
  return { name: m[1], args: m[2].trim() };
}

export function completions(registry: Map<string, Command>, prefix: string): string[] {
  return [...registry.keys()].filter(n => n.startsWith(prefix)).sort();
}
```

- [ ] **Step 4: Implement `src/commands/builtins.ts`**

```ts
import type { Command, CommandContext } from "./types.js";
import type { PermissionMode } from "../agent/session.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

const commands: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    async run(ctx) {
      const lines = commands.map(c => `/${c.name} — ${c.description}`).join("\n");
      ctx.notice(lines);
    }
  },
  {
    name: "clear",
    description: "Start a new session",
    async run(ctx) { await ctx.clearSession(); ctx.notice("Started a new session."); }
  },
  {
    name: "model",
    description: "Switch model: /model <model-name>",
    async run(ctx, args) {
      if (!args) { ctx.notice("Usage: /model <model-name>"); return; }
      await ctx.setModel(args);
      ctx.notice(`Model set to ${args}.`);
    }
  },
  {
    name: "permissions",
    description: "Set permission mode: /permissions <default|acceptEdits|bypassPermissions>",
    async run(ctx, args) {
      if (!MODES.includes(args as PermissionMode)) {
        ctx.notice("Valid modes: default, acceptEdits, bypassPermissions");
        return;
      }
      await ctx.setPermissionMode(args as PermissionMode);
      ctx.notice(`Permission mode: ${args}.`);
    }
  },
  {
    name: "provider",
    description: "Switch LLM provider: /provider <name>",
    async run(ctx, args) {
      if (!args) { ctx.notice(`Providers: ${ctx.providerNames().join(", ")}`); return; }
      await ctx.switchProvider(args);
    }
  },
  {
    name: "resume",
    description: "Pick a past session to resume",
    async run(ctx) { ctx.openResumePicker(); }
  },
  {
    name: "cost",
    description: "Show token/cost usage for this session",
    async run(ctx) { ctx.notice(ctx.costSummary()); }
  },
  {
    name: "exit",
    description: "Quit cloudcode",
    async run(ctx) { ctx.exit(); }
  }
];

export function buildRegistry(): Map<string, Command> {
  return new Map(commands.map(c => [c.name, c]));
}
```

Run: `npx vitest run tests/commands.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands tests/commands.test.ts
git commit -m "feat: slash command registry with v1 builtins"
```

---

### Task 6: Transcript rendering (MessageList)

**Files:**
- Create: `src/ui/transcript.ts` (pure message→display mapping), `src/ui/MessageList.tsx`
- Test: `tests/transcript.test.ts`, `tests/messageList.test.tsx`

**Interfaces:**
- Consumes: `SDKMessage` from the SDK.
- Produces:
  - ```ts
    type DisplayItem =
      | { kind: "user"; text: string }
      | { kind: "assistant"; text: string }
      | { kind: "tool"; label: string }          // e.g. "Read src/foo.ts"
      | { kind: "notice"; text: string }
      | { kind: "error"; text: string }
      | { kind: "result"; costUsd?: number; durationMs?: number };
    toDisplayItems(msg: SDKMessage): DisplayItem[]   // from transcript.ts
    toolLabel(name: string, input: Record<string, unknown>): string
    ```
  - `MessageList({ items }: { items: DisplayItem[] })` Ink component: user text prefixed `> `, tool items prefixed `⏺ ` (cyan), errors red, notices gray, assistant plain white.
- `toolLabel` rules: `Read/Write/Edit` → `file_path` value; `Bash` → `command` value truncated to 80 chars; otherwise JSON.stringify(input) truncated to 80 chars. Label format: `"<Name> <detail>"`.

- [ ] **Step 1: Write failing transcript tests**

```ts
// tests/transcript.test.ts
import { describe, it, expect } from "vitest";
import { toDisplayItems, toolLabel } from "../src/ui/transcript.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

describe("toolLabel", () => {
  it("shows file path for file tools", () => {
    expect(toolLabel("Read", { file_path: "/a/b.ts" })).toBe("Read /a/b.ts");
  });
  it("truncates long bash commands to 80 chars of detail", () => {
    const label = toolLabel("Bash", { command: "x".repeat(200) });
    expect(label.startsWith("Bash ")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(85);
  });
});

describe("toDisplayItems", () => {
  it("maps assistant text and tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: { content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", name: "Read", input: { file_path: "/x.ts" } }
      ] }
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([
      { kind: "assistant", text: "Let me look." },
      { kind: "tool", label: "Read /x.ts" }
    ]);
  });

  it("maps success result to result item", () => {
    const msg = {
      type: "result", subtype: "success", total_cost_usd: 0.02, duration_ms: 1200
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "result", costUsd: 0.02, durationMs: 1200 }]);
  });

  it("maps error result to error item", () => {
    const msg = {
      type: "result", subtype: "error_during_execution", result: "boom"
    } as unknown as SDKMessage;
    expect(toDisplayItems(msg)).toEqual([{ kind: "error", text: "boom" }]);
  });

  it("ignores system messages", () => {
    expect(toDisplayItems({ type: "system", subtype: "init" } as unknown as SDKMessage)).toEqual([]);
  });
});
```

Run: `npx vitest run tests/transcript.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `src/ui/transcript.ts`**

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  | { kind: "result"; costUsd?: number; durationMs?: number };

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function toolLabel(name: string, input: Record<string, unknown>): string {
  let detail: string;
  if (typeof input.file_path === "string") detail = input.file_path;
  else if (typeof input.command === "string") detail = truncate(input.command);
  else detail = truncate(JSON.stringify(input));
  return `${name} ${detail}`;
}

export function toDisplayItems(msg: SDKMessage): DisplayItem[] {
  const m = msg as Record<string, unknown>;
  if (m.type === "assistant") {
    const content = (m.message as { content: Array<Record<string, unknown>> }).content ?? [];
    const items: DisplayItem[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push({ kind: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        items.push({
          kind: "tool",
          label: toolLabel(String(block.name), (block.input ?? {}) as Record<string, unknown>)
        });
      }
    }
    return items;
  }
  if (m.type === "result") {
    if (m.subtype === "success") {
      return [{ kind: "result", costUsd: m.total_cost_usd as number, durationMs: m.duration_ms as number }];
    }
    return [{ kind: "error", text: String(m.result ?? m.subtype) }];
  }
  return [];
}
```

Run: `npx vitest run tests/transcript.test.ts` — Expected: PASS.

- [ ] **Step 3: Write failing MessageList test**

```tsx
// tests/messageList.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { MessageList } from "../src/ui/MessageList.js";

describe("MessageList", () => {
  it("renders user, tool, and assistant items with prefixes", () => {
    const { lastFrame } = render(
      <MessageList items={[
        { kind: "user", text: "fix the bug" },
        { kind: "tool", label: "Read /x.ts" },
        { kind: "assistant", text: "Done." }
      ]} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> fix the bug");
    expect(frame).toContain("⏺ Read /x.ts");
    expect(frame).toContain("Done.");
  });
});
```

Run: `npx vitest run tests/messageList.test.tsx` — Expected: FAIL.

- [ ] **Step 4: Implement `src/ui/MessageList.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./transcript.js";

export function MessageList({ items }: { items: DisplayItem[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        switch (item.kind) {
          case "user":
            return <Text key={i} color="blue">{"> "}{item.text}</Text>;
          case "assistant":
            return <Text key={i}>{item.text}</Text>;
          case "tool":
            return <Text key={i} color="cyan">{"⏺ "}{item.label}</Text>;
          case "notice":
            return <Text key={i} color="gray">{item.text}</Text>;
          case "error":
            return <Text key={i} color="red">{item.text}</Text>;
          case "result":
            return (
              <Text key={i} color="gray" dimColor>
                {`✓ done${item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ""}${item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}`}
              </Text>
            );
        }
      })}
    </Box>
  );
}
```

Run: `npx vitest run tests/messageList.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui tests/transcript.test.ts tests/messageList.test.tsx
git commit -m "feat: transcript mapping and MessageList component"
```

---

### Task 7: InputBox and PermissionDialog

**Files:**
- Create: `src/ui/InputBox.tsx`, `src/ui/PermissionDialog.tsx`
- Test: `tests/inputBox.test.tsx`, `tests/permissionDialog.test.tsx`

**Interfaces:**
- Consumes: `completions` from `registry.js`, `Command` map, `PermissionRequest` from `session.js`.
- Produces:
  - `InputBox({ registry, onSubmit, disabled }: { registry: Map<string, Command>; onSubmit(text: string): void; disabled: boolean })` — bordered single-line input; typing `/pre` shows completion hints below; Enter submits and clears; Tab completes to the single match; when `disabled`, input is inert and shows a gray "working… (Esc to interrupt)" hint.
  - `PermissionDialog({ request, onDecision }: { request: { toolName: string; input: Record<string, unknown> }; onDecision(allow: boolean): void })` — shows tool label, Y/N keys and arrow+Enter selection between "Yes" and "No".
- Both components use Ink's `useInput`.

- [ ] **Step 1: Write failing InputBox test**

```tsx
// tests/inputBox.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/ui/InputBox.js";
import { buildRegistry } from "../src/commands/builtins.js";

const wait = () => new Promise(r => setTimeout(r, 20));

describe("InputBox", () => {
  it("submits typed text on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} />);
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("shows slash completions", async () => {
    const { stdin, lastFrame } = render(<InputBox registry={buildRegistry()} onSubmit={() => {}} disabled={false} />);
    stdin.write("/pro");
    await wait();
    expect(lastFrame()).toContain("provider");
  });
});
```

Run: `npx vitest run tests/inputBox.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `src/ui/InputBox.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { completions } from "../commands/registry.js";
import type { Command } from "../commands/types.js";

interface Props {
  registry: Map<string, Command>;
  onSubmit(text: string): void;
  disabled: boolean;
}

export function InputBox({ registry, onSubmit, disabled }: Props) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const text = value.trim();
      setValue("");
      if (text) onSubmit(text);
    } else if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
    } else if (key.tab) {
      const m = /^\/(\w*)$/.exec(value);
      if (m) {
        const matches = completions(registry, m[1]);
        if (matches.length === 1) setValue(`/${matches[0]} `);
      }
    } else if (input && !key.ctrl && !key.meta) {
      setValue(v => v + input);
    }
  });

  const slashMatch = /^\/(\w*)$/.exec(value);
  const hints = slashMatch ? completions(registry, slashMatch[1]) : [];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{value}{disabled ? "" : "█"}</Text>
      </Box>
      {disabled && <Text color="gray">working… (Esc to interrupt)</Text>}
      {!disabled && hints.length > 0 && (
        <Text color="gray">{hints.map(h => `/${h}`).join("  ")}</Text>
      )}
    </Box>
  );
}
```

Run: `npx vitest run tests/inputBox.test.tsx` — Expected: PASS.

- [ ] **Step 3: Write failing PermissionDialog test**

```tsx
// tests/permissionDialog.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PermissionDialog } from "../src/ui/PermissionDialog.js";

const wait = () => new Promise(r => setTimeout(r, 20));

describe("PermissionDialog", () => {
  it("renders the tool request and resolves yes on 'y'", async () => {
    const onDecision = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={onDecision} />
    );
    expect(lastFrame()).toContain("Bash");
    expect(lastFrame()).toContain("ls");
    stdin.write("y");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("resolves no on 'n'", async () => {
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={onDecision} />
    );
    stdin.write("n");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
```

Run: `npx vitest run tests/permissionDialog.test.tsx` — Expected: FAIL.

- [ ] **Step 4: Implement `src/ui/PermissionDialog.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { toolLabel } from "./transcript.js";

interface Props {
  request: { toolName: string; input: Record<string, unknown> };
  onDecision(allow: boolean): void;
}

export function PermissionDialog({ request, onDecision }: Props) {
  const [selected, setSelected] = useState<0 | 1>(0); // 0 = Yes, 1 = No

  useInput((input, key) => {
    if (input.toLowerCase() === "y") onDecision(true);
    else if (input.toLowerCase() === "n" || key.escape) onDecision(false);
    else if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected(s => (s === 0 ? 1 : 0));
    } else if (key.return) onDecision(selected === 0);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Permission required</Text>
      <Text>{toolLabel(request.toolName, request.input)}</Text>
      <Box gap={2}>
        <Text inverse={selected === 0}> Yes (y) </Text>
        <Text inverse={selected === 1}> No (n) </Text>
      </Box>
    </Box>
  );
}
```

Run: `npx vitest run tests/permissionDialog.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/InputBox.tsx src/ui/PermissionDialog.tsx tests/inputBox.test.tsx tests/permissionDialog.test.tsx
git commit -m "feat: input box with slash completion and permission dialog"
```

---

### Task 8: App state machine, StatusBar, ResumePicker

**Files:**
- Create: `src/ui/StatusBar.tsx`, `src/ui/ResumePicker.tsx`, `src/ui/App.tsx`
- Test: `tests/app.test.tsx`

**Interfaces:**
- Consumes: everything above — `AgentSession`, `buildRegistry`, `parseSlash`, `toDisplayItems`, `MessageList`, `InputBox`, `PermissionDialog`, `SessionIndex`, `loadProviders`.
- Produces:
  - `App(props: AppProps)` where:
    ```ts
    interface AppProps {
      cwd: string;
      providers: Record<string, ProviderConfig>;
      initialProvider: string;
      resume?: string;                 // session id to resume
      sessionIndex: SessionIndex;
      queryFn?: typeof query;          // injected in tests
    }
    ```
  - `StatusBar({ provider, model, mode, cwd })` — one gray line.
  - `ResumePicker({ entries, onPick, onCancel })` — arrow-key list of `SessionEntry`, Enter picks (`onPick(entry)`), Esc cancels.
- App behavior (state machine):
  - phases: `"idle" | "streaming" | "permission"`; permission requests queue and display one at a time.
  - On submit: slash input → command registry (unknown command → notice `Unknown command: /x`); plain text → `items += user item`, `session.send(text)`, phase `streaming`.
  - On any `result` message: phase back to `idle`; accumulate `total_cost_usd` for `/cost`.
  - `Esc` during `streaming` → `session.interrupt()`.
  - Ctrl+C: first press interrupts, second within 2s exits (Ink `useApp().exit()` after `session.dispose()`).
  - Shift+Tab cycles permission modes in order `default → acceptEdits → bypassPermissions → default`.
  - `switchProvider(name)`: unknown name → notice; else `dispose()` old session, create+start new `AgentSession` with the provider's config (fresh session, no resume), notice `Provider: <name>`; on start error, notice and fall back to previous provider.
  - First user message of a session → `sessionIndex.record({...})` once the session id is known.
  - CommandContext implementation lives inside App (wires ctx methods to session/state).

- [ ] **Step 1: Write failing App integration test (mocked SDK)**

```tsx
// tests/app.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

function fakeQueryFn() {
  return (args: { prompt: AsyncIterable<unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const _ of args.prompt) {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hello from model" }] } };
        yield { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 500 };
      }
    })();
    return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
  };
}

function makeApp() {
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  return render(
    <App
      cwd="/p"
      providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
      initialProvider="anthropic"
      sessionIndex={index}
      queryFn={fakeQueryFn() as never}
    />
  );
}

describe("App", () => {
  it("round-trips a user message to assistant output", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("> hi");
    expect(lastFrame()).toContain("hello from model");
  });

  it("handles unknown slash command with a notice", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/nope");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("Unknown command: /nope");
  });

  it("switches provider via /provider and shows it in status bar", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/provider local");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("local");
  });
});
```

Run: `npx vitest run tests/app.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `src/ui/StatusBar.tsx`**

```tsx
import React from "react";
import { Text } from "ink";

interface Props { provider: string; model?: string; mode: string; cwd: string }

export function StatusBar({ provider, model, mode, cwd }: Props) {
  return (
    <Text color="gray" dimColor>
      {provider}{model ? `/${model}` : ""} · {mode} · {cwd}
    </Text>
  );
}
```

- [ ] **Step 3: Implement `src/ui/ResumePicker.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionEntry } from "../agent/sessionIndex.js";

interface Props {
  entries: SessionEntry[];
  onPick(entry: SessionEntry): void;
  onCancel(): void;
}

export function ResumePicker({ entries, onPick, onCancel }: Props) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(entries.length - 1, i + 1));
    else if (key.return && entries[index]) onPick(entries[index]);
  });

  if (entries.length === 0) {
    return <Text color="gray">No past sessions. Press Esc to close.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="yellow">Resume a session (↑/↓, Enter, Esc)</Text>
      {entries.map((e, i) => (
        <Text key={e.id} inverse={i === index}>
          {e.timestamp}  [{e.provider}]  {e.firstMessage.slice(0, 60)}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Implement `src/ui/App.tsx`**

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { buildRegistry, } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { toDisplayItems, type DisplayItem } from "./transcript.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { StatusBar } from "./StatusBar.js";
import { ResumePicker } from "./ResumePicker.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  resume?: string;
  sessionIndex: SessionIndex;
  queryFn?: typeof query;
}

type Phase = "idle" | "streaming" | "permission";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

export function App(props: AppProps) {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [providerName, setProviderName] = useState(props.initialProvider);
  const [model, setModel] = useState<string | undefined>(props.providers[props.initialProvider]?.model);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const costRef = useRef(0);
  const firstMessageRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<AgentSession | null>(null);
  const lastCtrlCRef = useRef(0);
  const registry = useMemo(() => buildRegistry(), []);

  const notice = (text: string) => setItems(prev => [...prev, { kind: "notice", text }]);

  function handleMessage(msg: SDKMessage): void {
    const mapped = toDisplayItems(msg);
    if (mapped.length > 0) setItems(prev => [...prev, ...mapped]);
    const t = (msg as { type: string }).type;
    if (t === "result") {
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") costRef.current += cost;
      setPhase("idle");
    }
  }

  function createSession(name: string, resume?: string): AgentSession {
    const session = new AgentSession({
      providerName: name,
      provider: props.providers[name],
      model: props.providers[name]?.model,
      permissionMode: mode,
      resume,
      cwd: props.cwd,
      onMessage: handleMessage,
      onPermissionRequest: req => {
        setPermissionQueue(q => [...q, req]);
        setPhase("permission");
      },
      onSessionId: id => {
        if (firstMessageRef.current) recordSession(id, name);
      },
      queryFn: props.queryFn
    });
    session.start();
    return session;
  }

  function recordSession(id: string, provider: string): void {
    props.sessionIndex.record({
      id,
      cwd: props.cwd,
      firstMessage: firstMessageRef.current ?? "",
      timestamp: new Date().toISOString(),
      provider
    });
  }

  useEffect(() => {
    sessionRef.current = createSession(props.initialProvider, props.resume);
    return () => { void sessionRef.current?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restartSession(name: string, resume?: string): Promise<void> {
    await sessionRef.current?.dispose();
    firstMessageRef.current = undefined;
    sessionRef.current = createSession(name, resume);
  }

  const ctx: CommandContext = {
    notice,
    clearSession: async () => { setItems([]); await restartSession(providerName); },
    setModel: async m => { await sessionRef.current?.setModel(m); setModel(m); },
    setPermissionMode: async m => {
      await sessionRef.current?.setPermissionMode(m as PermissionMode);
      setMode(m as PermissionMode);
    },
    switchProvider: async name => {
      if (!props.providers[name]) { notice(`Unknown provider: ${name}. Providers: ${Object.keys(props.providers).join(", ")}`); return; }
      const previous = providerName;
      try {
        await restartSession(name);
        setProviderName(name);
        setModel(props.providers[name]?.model);
        notice(`Provider: ${name}`);
      } catch (err) {
        notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
        await restartSession(previous);
      }
    },
    openResumePicker: () => setShowResumePicker(true),
    costSummary: () => `Session cost: $${costRef.current.toFixed(4)}`,
    providerNames: () => Object.keys(props.providers),
    exit: () => { void sessionRef.current?.dispose(); exit(); }
  };

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = registry.get(slash.name);
      if (!cmd) { notice(`Unknown command: /${slash.name}`); return; }
      void cmd.run(ctx, slash.args);
      return;
    }
    if (!firstMessageRef.current) {
      firstMessageRef.current = text;
      if (sessionRef.current?.sessionId) recordSession(sessionRef.current.sessionId, providerName);
    }
    setItems(prev => [...prev, { kind: "user", text }]);
    setPhase("streaming");
    sessionRef.current?.send(text);
  }

  useInput((_input, key) => {
    if (key.escape && phase === "streaming") void sessionRef.current?.interrupt();
    if (key.tab && key.shift) {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
      void ctx.setPermissionMode(next);
    }
    if (key.ctrl && _input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) ctx.exit();
      else { lastCtrlCRef.current = now; void sessionRef.current?.interrupt(); notice("Press Ctrl+C again to exit."); }
    }
  });

  const activePermission = permissionQueue[0];

  function decidePermission(allow: boolean): void {
    activePermission?.resolve(allow);
    setPermissionQueue(q => {
      const rest = q.slice(1);
      if (rest.length === 0) setPhase("streaming");
      return rest;
    });
  }

  return (
    <Box flexDirection="column">
      <MessageList items={items} />
      {showResumePicker && (
        <ResumePicker
          entries={props.sessionIndex.list()}
          onPick={e => { setShowResumePicker(false); setItems([]); void restartSession(e.provider, e.id); }}
          onCancel={() => setShowResumePicker(false)}
        />
      )}
      {phase === "permission" && activePermission && (
        <PermissionDialog request={activePermission} onDecision={decidePermission} />
      )}
      {!showResumePicker && phase !== "permission" && (
        <InputBox registry={registry} onSubmit={handleSubmit} disabled={phase === "streaming"} />
      )}
      <StatusBar provider={providerName} model={model} mode={mode} cwd={props.cwd} />
    </Box>
  );
}
```

Note: `ResumePicker` `onPick` passes `e.provider` as the provider name for the restarted session — if the entry's provider no longer exists in config, fall back to the current provider (`props.providers[e.provider] ? e.provider : providerName`). Include that guard.

Run: `npx vitest run tests/app.test.tsx` — Expected: PASS. Also `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui tests/app.test.tsx
git commit -m "feat: App state machine with status bar and resume picker"
```

---

### Task 9: CLI entry point and end-to-end smoke

**Files:**
- Create: `src/cli.tsx`
- Modify: `README.md` (create)
- Test: manual smoke (interactive TUI; no automated test for the binary itself)

**Interfaces:**
- Consumes: `App`, `loadProviders`, `SessionIndex`, `VERSION`.
- Produces: `cloudcode` binary behavior — flags `--continue`, `--resume`, `--provider <name>`, `--version`.

- [ ] **Step 1: Implement `src/cli.tsx`**

```tsx
import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./ui/App.js";
import { loadProviders } from "./agent/providers.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string", default: "anthropic" },
    version: { type: "boolean", default: false }
  }
});

if (values.version) {
  console.log(`cloudcode ${VERSION}`);
  process.exit(0);
}

const providers = loadProviders();
if (!providers[values.provider!]) {
  console.error(`Unknown provider "${values.provider}". Known: ${Object.keys(providers).join(", ")}`);
  process.exit(1);
}

const sessionIndex = new SessionIndex();
const cwd = process.cwd();
let resume: string | undefined;
if (values.continue) {
  resume = sessionIndex.latestForCwd(cwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

render(
  <App
    cwd={cwd}
    providers={providers}
    initialProvider={values.provider!}
    resume={resume}
    sessionIndex={sessionIndex}
  />
);
```

Note: `--resume` (the picker flag) is handled by rendering App and immediately opening the resume picker — add an optional `openResumeOnStart?: boolean` prop to `AppProps`, defaulted false, set from `values.resume`, and initialize `showResumePicker` state with it.

- [ ] **Step 2: Full test suite and typecheck**

Run: `npx vitest run` — Expected: all tests PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev` (requires `ANTHROPIC_API_KEY` or an existing Claude Code login).
Verify: prompt renders; sending "list the files in this directory" streams a tool chip and reply; `/help` lists 8 commands; `/cost` prints a dollar figure; Ctrl+C twice exits.

For local provider: start `llama-server` with an Anthropic-compat build, write `~/.cloudcode/providers.json` with the `local` entry, run `npm run dev -- --provider local`, send a message, verify a reply arrives.

- [ ] **Step 4: Write README.md**

```markdown
# cloudcode

A Claude Code-style terminal coding agent built on the Claude Agent SDK, with an Ink
TUI, slash commands, session resume, permission modes, and switchable providers
including local llama.cpp.

## Setup

    npm install
    npm run dev

Auth: set `ANTHROPIC_API_KEY`, or rely on an existing Claude Code login.

## Local models (llama.cpp)

Requires a recent llama.cpp build whose `llama-server` exposes the
Anthropic-compatible `/v1/messages` endpoint. Create `~/.cloudcode/providers.json`:

    {
      "local": {
        "baseUrl": "http://127.0.0.1:8080",
        "apiKey": "none",
        "model": "qwen2.5-coder-32b"
      }
    }

Then `npm run dev -- --provider local` or `/provider local` at runtime.

Note: local models are markedly weaker at agentic tool use than Claude; degraded
behavior on local providers is a model limitation, not a cloudcode bug.

## Commands

/help /clear /model /permissions /provider /resume /cost /exit
Shift+Tab cycles permission modes. Esc interrupts. Ctrl+C twice exits.
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.tsx README.md
git commit -m "feat: CLI entry point with continue/resume/provider flags"
```
