# LSP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cloudcode a shared LSP client layer that powers agent-facing navigation tools (Definition, References, Hover, Symbols), a pull-based Diagnostics tool, and auto-injected diagnostics after Edit/Write.

**Architecture:** A per-session `LspManager` owns a registry (built-in defaults merged with `lsp.json` overrides), lazy-spawns and pools one `LspServer` child process per (language, workspace-root), and caches `publishDiagnostics` per file URI. The manager is threaded into `ToolContext.lsp`; tools read from it, and `runTool` in the engine loop appends diagnostics after successful edits.

**Tech Stack:** TypeScript (ESM, NodeNext — all local imports use `.js` extensions), `node:child_process`, `node:fs`, `node:path`, vitest. No new runtime dependencies.

## Global Constraints

- All code, comments, and identifiers in English only.
- ESM with NodeNext resolution: every local import MUST use a `.js` extension (e.g. `import { x } from "./rpc.js"`).
- Use `node:`-prefixed builtins (`node:fs`, `node:path`, `node:child_process`, `node:os`).
- Follow the existing `ToolDef` shape in `src/engine/tools/types.ts` (`name`, `description`, `input_schema`, `execute(input, ctx)`).
- Tools resolve relative paths against `ctx.cwd`; never throw out of `execute` for expected conditions — return `{ content, isError }`.
- Tests run with `npm run test` (vitest). Lint with `npm run lint` (oxlint). Build check with `npm run build` (tsc).
- New LSP code lives under `src/engine/lsp/`; tests under `tests/lsp/`.
- Config dir is `~/.cloudcode` via `configDir()` in `src/agent/providers.ts` — reuse it, do not re-derive.

---

### Task 1: JSON-RPC framing (rpc.ts)

Pure, dependency-free encode/decode of LSP's `Content-Length`-framed JSON-RPC messages. This is the foundation every server interaction sits on.

**Files:**
- Create: `src/engine/lsp/rpc.ts`
- Test: `tests/lsp/rpc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `encodeMessage(msg: unknown): Buffer` — serializes to `Content-Length: N\r\n\r\n{json}`.
  - `class MessageBuffer { push(chunk: Buffer): void; drain(): unknown[] }` — accumulates bytes, returns fully-parsed messages, retains partial remainder.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/rpc.test.ts
import { describe, it, expect } from "vitest";
import { encodeMessage, MessageBuffer } from "../../src/engine/lsp/rpc.js";

describe("encodeMessage", () => {
  it("prefixes a Content-Length header and JSON body", () => {
    const out = encodeMessage({ jsonrpc: "2.0", id: 1, method: "x" }).toString("utf8");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(out).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });
});

describe("MessageBuffer", () => {
  it("parses a single complete message", () => {
    const buf = new MessageBuffer();
    buf.push(encodeMessage({ id: 1 }));
    expect(buf.drain()).toEqual([{ id: 1 }]);
  });

  it("parses two messages arriving in one chunk", () => {
    const buf = new MessageBuffer();
    buf.push(Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })]));
    expect(buf.drain()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reassembles a message split across chunks", () => {
    const whole = encodeMessage({ hello: "world" });
    const buf = new MessageBuffer();
    buf.push(whole.subarray(0, 10));
    expect(buf.drain()).toEqual([]);
    buf.push(whole.subarray(10));
    expect(buf.drain()).toEqual([{ hello: "world" }]);
  });

  it("handles a multi-byte UTF-8 body by byte length, not char length", () => {
    const buf = new MessageBuffer();
    buf.push(encodeMessage({ s: "café→" }));
    expect(buf.drain()).toEqual([{ s: "café→" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/rpc.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/lsp/rpc.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/lsp/rpc.ts
export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export class MessageBuffer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  drain(): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: drop up to the separator to avoid a stuck buffer.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) break;
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        // Skip a malformed body rather than throwing.
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lsp/rpc.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/lsp/rpc.ts tests/lsp/rpc.test.ts
git commit -m "feat(lsp): add JSON-RPC message framing"
```

---

### Task 2: Registry defaults and config merge (defaults.ts, config.ts)

The built-in server table plus loading and merging `lsp.json` overrides (user-global and project-local).

**Files:**
- Create: `src/engine/lsp/defaults.ts`
- Create: `src/engine/lsp/config.ts`
- Test: `tests/lsp/config.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.js`.
- Produces:
  - `interface ServerConfig { extensions: string[]; command: string; args: string[]; rootMarkers: string[]; enabled?: boolean }`
  - `DEFAULT_SERVERS: Record<string, ServerConfig>` (keys: `typescript`, `python`, `rust`, `go`).
  - `loadRegistry(userPath?: string, projectPath?: string): Record<string, ServerConfig>` — merges project over user over defaults by language name, drops entries with `enabled === false`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/config.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVERS, loadRegistry } from "../../src/engine/lsp/config.js";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lsp-"));
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("loadRegistry", () => {
  it("returns defaults when no config files exist", () => {
    const reg = loadRegistry("/no/such/user.json", "/no/such/project.json");
    expect(Object.keys(reg).sort()).toEqual(["go", "python", "rust", "typescript"]);
    expect(reg.typescript.command).toBe(DEFAULT_SERVERS.typescript.command);
  });

  it("merges a user override onto a default entry", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ typescript: { command: "my-ts", args: ["--stdio"] } }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.typescript.command).toBe("my-ts");
    expect(reg.typescript.extensions).toEqual(DEFAULT_SERVERS.typescript.extensions);
  });

  it("adds a new language from config", () => {
    const user = tmpFile("lsp.json", JSON.stringify({
      elixir: { extensions: [".ex"], command: "elixir-ls", args: [], rootMarkers: ["mix.exs"] }
    }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.elixir.command).toBe("elixir-ls");
  });

  it("removes an entry disabled with enabled:false", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ go: { enabled: false } }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.go).toBeUndefined();
  });

  it("lets project config win over user config", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ python: { command: "user-py" } }));
    const project = tmpFile("lsp.json", JSON.stringify({ python: { command: "project-py" } }));
    const reg = loadRegistry(user, project);
    expect(reg.python.command).toBe("project-py");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/config.test.ts`
Expected: FAIL — cannot resolve `config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/lsp/defaults.ts
export interface ServerConfig {
  extensions: string[];
  command: string;
  args: string[];
  rootMarkers: string[];
  enabled?: boolean;
}

export const DEFAULT_SERVERS: Record<string, ServerConfig> = {
  typescript: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"]
  },
  python: {
    extensions: [".py", ".pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", ".git"]
  },
  rust: {
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml", ".git"]
  },
  go: {
    extensions: [".go"],
    command: "gopls",
    args: [],
    rootMarkers: ["go.mod", ".git"]
  }
};
```

```ts
// src/engine/lsp/config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { DEFAULT_SERVERS, type ServerConfig } from "./defaults.js";

export { DEFAULT_SERVERS, type ServerConfig };

function readJson(path: string): Record<string, Partial<ServerConfig>> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadRegistry(
  userPath: string = join(configDir(), "lsp.json"),
  projectPath: string = join(process.cwd(), ".cloudcode", "lsp.json")
): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = {};
  for (const [lang, cfg] of Object.entries(DEFAULT_SERVERS)) merged[lang] = { ...cfg };

  for (const overrides of [readJson(userPath), readJson(projectPath)]) {
    for (const [lang, cfg] of Object.entries(overrides)) {
      merged[lang] = { ...(merged[lang] ?? { extensions: [], command: "", args: [], rootMarkers: [] }), ...cfg };
    }
  }

  for (const [lang, cfg] of Object.entries(merged)) {
    if (cfg.enabled === false) delete merged[lang];
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lsp/config.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/lsp/defaults.ts src/engine/lsp/config.ts tests/lsp/config.test.ts
git commit -m "feat(lsp): add server registry defaults and config merge"
```

---

### Task 3: Language detection and server availability (detect.ts)

Map a file to a language by extension, find its workspace root by walking up to a root marker, and check whether a server command exists on `PATH`.

**Files:**
- Create: `src/engine/lsp/detect.ts`
- Test: `tests/lsp/detect.test.ts`

**Interfaces:**
- Consumes: `ServerConfig` from `defaults.js`.
- Produces:
  - `detectLanguage(filePath: string, registry: Record<string, ServerConfig>): string | undefined`
  - `findRoot(filePath: string, markers: string[], fallback: string): string`
  - `commandExists(command: string): boolean` — resolves against `PATH` (and `PATHEXT` on Windows), cached per command.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/detect.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage, findRoot, commandExists } from "../../src/engine/lsp/detect.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

describe("detectLanguage", () => {
  it("matches by extension", () => {
    expect(detectLanguage("/a/b/foo.ts", DEFAULT_SERVERS)).toBe("typescript");
    expect(detectLanguage("/a/b/foo.py", DEFAULT_SERVERS)).toBe("python");
    expect(detectLanguage("/a/b/foo.txt", DEFAULT_SERVERS)).toBeUndefined();
  });
});

describe("findRoot", () => {
  it("walks up to the nearest marker", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    writeFileSync(join(root, "go.mod"), "module x", "utf8");
    const nested = join(root, "pkg", "sub");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "main.go");
    writeFileSync(file, "package main", "utf8");
    expect(findRoot(file, ["go.mod"], "/fallback")).toBe(root);
  });

  it("returns the fallback when no marker is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "noroot-"));
    const file = join(dir, "main.go");
    writeFileSync(file, "package main", "utf8");
    expect(findRoot(file, ["go.mod"], "/fallback")).toBe("/fallback");
  });
});

describe("commandExists", () => {
  it("finds node on PATH and rejects a bogus command", () => {
    expect(commandExists("node")).toBe(true);
    expect(commandExists("definitely-not-a-real-command-xyz")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/detect.test.ts`
Expected: FAIL — cannot resolve `detect.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/lsp/detect.ts
import { existsSync } from "node:fs";
import { dirname, extname, join, delimiter } from "node:path";
import type { ServerConfig } from "./defaults.js";

export function detectLanguage(
  filePath: string,
  registry: Record<string, ServerConfig>
): string | undefined {
  const ext = extname(filePath).toLowerCase();
  for (const [lang, cfg] of Object.entries(registry)) {
    if (cfg.extensions.includes(ext)) return lang;
  }
  return undefined;
}

export function findRoot(filePath: string, markers: string[], fallback: string): string {
  let dir = dirname(filePath);
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

const existsCache = new Map<string, boolean>();

export function commandExists(command: string): boolean {
  const cached = existsCache.get(command);
  if (cached !== undefined) return cached;

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  let found = false;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) { found = true; break outer; }
    }
  }
  existsCache.set(command, found);
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lsp/detect.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/lsp/detect.ts tests/lsp/detect.test.ts
git commit -m "feat(lsp): add language detection, root discovery, PATH check"
```

---

### Task 4: LspServer process wrapper (server.ts)

Wrap one child process: framed I/O, `initialize` handshake, request/response correlation, document sync, and `publishDiagnostics` capture. Tested against a fake stdio server so no real language server is required.

**Files:**
- Create: `src/engine/lsp/server.ts`
- Create: `tests/lsp/fakeServer.ts` (test helper — a scripted stdio LSP responder)
- Test: `tests/lsp/server.test.ts`

**Interfaces:**
- Consumes: `encodeMessage`, `MessageBuffer` from `rpc.js`.
- Produces:
  - `interface Diagnostic { line: number; column: number; severity: number; message: string; code?: string }` (positions 0-based as received from LSP)
  - `interface Location { uri: string; line: number; column: number }`
  - `class LspServer`:
    - `constructor(command: string, args: string[], rootPath: string, onDiagnostics: (uri: string, diags: Diagnostic[]) => void)`
    - `start(): Promise<void>` — spawns, initializes; idempotent (shared init promise).
    - `didOpen(uri: string, text: string): void`
    - `didChange(uri: string, text: string): void`
    - `request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>`
    - `stop(): void`
    - `get alive(): boolean`
  - For tests: accept an injectable spawn function via a second constructor arg object `{ spawnFn?: typeof spawn }` (default real `spawn`).

**Note on the fake server:** `tests/lsp/fakeServer.ts` returns an object shaped like a `ChildProcess` (`stdin.write`, `stdout` as a readable emitting `data`, `on("exit")`, `kill()`). It parses framed requests with `MessageBuffer`, replies to `initialize` with an empty-ish capabilities result, echoes canned `definition`/`references`/`hover` results, and — when it receives `didOpen`/`didChange` for a URI whose text contains the token `BAD` — emits a `publishDiagnostics` notification for that URI.

- [ ] **Step 1: Write the fake server helper**

```ts
// tests/lsp/fakeServer.ts
import { EventEmitter } from "node:events";
import { encodeMessage, MessageBuffer } from "../../src/engine/lsp/rpc.js";

// Minimal ChildProcess-like object driven by the LSP messages it receives.
export function makeFakeServer() {
  const stdout = new EventEmitter() as EventEmitter & { on: any };
  const buffer = new MessageBuffer();
  const emitted: unknown[] = [];

  function send(msg: unknown) {
    emitted.push(msg);
    stdout.emit("data", encodeMessage(msg));
  }

  const stdin = {
    write(chunk: Buffer) {
      buffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (const raw of buffer.drain()) handle(raw as any);
      return true;
    }
  };

  function handle(msg: { id?: number; method?: string; params?: any }) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
      return;
    }
    if (msg.method === "textDocument/definition") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///def.ts", range: { start: { line: 4, character: 2 } } }] });
      return;
    }
    if (msg.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**const** x: number" } } });
      return;
    }
    if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
      const uri = msg.params.textDocument.uri;
      const text = msg.method === "textDocument/didOpen"
        ? msg.params.textDocument.text
        : msg.params.contentChanges[0].text;
      if (String(text).includes("BAD")) {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            diagnostics: [{ range: { start: { line: 0, character: 4 } }, severity: 1, message: "bad token", code: "E1" }]
          }
        });
      }
      return;
    }
    // initialized / shutdown / exit: ignore.
  }

  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  proc.kill = () => proc.emit("exit", 0, null);
  proc.emitted = emitted;
  return proc;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/lsp/server.test.ts
import { describe, it, expect } from "vitest";
import { LspServer } from "../../src/engine/lsp/server.js";
import { makeFakeServer } from "./fakeServer.js";

function newServer(onDiag = (_u: string, _d: unknown[]) => {}) {
  const fake = makeFakeServer();
  const server = new LspServer("fake", [], "/root", onDiag as any, { spawnFn: () => fake as any });
  return { server, fake };
}

describe("LspServer", () => {
  it("initializes and resolves start() once", async () => {
    const { server } = newServer();
    await server.start();
    await server.start(); // idempotent
    expect(server.alive).toBe(true);
  });

  it("returns a definition result", async () => {
    const { server } = newServer();
    await server.start();
    const result = await server.request("textDocument/definition", {});
    expect(result).toEqual([{ uri: "file:///def.ts", range: { start: { line: 4, character: 2 } } }]);
  });

  it("captures publishDiagnostics via the callback on didChange", async () => {
    const seen: Array<{ uri: string; diags: any[] }> = [];
    const { server } = newServer((uri, diags) => seen.push({ uri, diags: diags as any[] }));
    await server.start();
    server.didOpen("file:///a.ts", "ok");
    server.didChange("file:///a.ts", "BAD code");
    await new Promise(r => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0].uri).toBe("file:///a.ts");
    expect(seen[0].diags[0].message).toBe("bad token");
    expect(seen[0].diags[0].line).toBe(0);
    expect(seen[0].diags[0].column).toBe(4);
  });

  it("rejects a pending request when aborted", async () => {
    const { server } = newServer();
    await server.start();
    const ctrl = new AbortController();
    const p = server.request("textDocument/references", {}, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/lsp/server.test.ts`
Expected: FAIL — cannot resolve `server.js`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/engine/lsp/server.ts
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { encodeMessage, MessageBuffer } from "./rpc.js";

export interface Diagnostic {
  line: number;
  column: number;
  severity: number;
  message: string;
  code?: string;
}

export interface Location {
  uri: string;
  line: number;
  column: number;
}

type SpawnFn = (command: string, args: string[], options: object) => ChildProcess;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export function fileUri(path: string): string {
  return pathToFileURL(path).toString();
}

export class LspServer {
  private proc: ChildProcess | undefined;
  private buffer = new MessageBuffer();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private startPromise: Promise<void> | undefined;
  private opened = new Set<string>();
  private versions = new Map<string, number>();
  private dead = false;

  constructor(
    private command: string,
    private args: string[],
    private rootPath: string,
    private onDiagnostics: (uri: string, diags: Diagnostic[]) => void,
    private deps: { spawnFn?: SpawnFn } = {}
  ) {}

  get alive(): boolean {
    return !this.dead && this.proc !== undefined;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private doStart(): Promise<void> {
    const spawnFn = this.deps.spawnFn ?? spawn;
    const proc = spawnFn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("exit", () => this.markDead(new Error("language server exited")));
    proc.on("error", (err: Error) => this.markDead(err));

    return this.request("initialize", {
      processId: process.pid,
      rootUri: fileUri(this.rootPath),
      capabilities: { textDocument: { publishDiagnostics: {} } }
    }).then(() => {
      this.notify("initialized", {});
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer.push(chunk);
    for (const msg of this.buffer.drain()) this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.onAbort && p.signal) p.signal.removeEventListener("abort", p.onAbort);
      if (msg.error) p.reject(new Error(String((msg.error as { message?: string }).message ?? "LSP error")));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: RawDiag[] };
      this.onDiagnostics(params.uri, params.diagnostics.map(normalizeDiag));
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("language server is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          reject(new Error("aborted"));
        };
        pending.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    this.proc?.stdin?.write(encodeMessage(msg));
  }

  didOpen(uri: string, text: string): void {
    this.opened.add(uri);
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "plaintext", version: 1, text }
    });
  }

  didChange(uri: string, text: string): void {
    if (!this.opened.has(uri)) { this.didOpen(uri, text); return; }
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  isOpen(uri: string): boolean {
    return this.opened.has(uri);
  }

  stop(): void {
    if (this.dead) return;
    try {
      this.notify("shutdown", null);
      this.notify("exit", null);
    } catch {
      // best-effort
    }
    this.proc?.kill();
    this.markDead(new Error("stopped"));
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

interface RawDiag {
  range: { start: { line: number; character: number } };
  severity?: number;
  message: string;
  code?: string | number;
}

function normalizeDiag(d: RawDiag): Diagnostic {
  return {
    line: d.range.start.line,
    column: d.range.start.character,
    severity: d.severity ?? 1,
    message: d.message,
    code: d.code === undefined ? undefined : String(d.code)
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lsp/server.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/engine/lsp/server.ts tests/lsp/fakeServer.ts tests/lsp/server.test.ts
git commit -m "feat(lsp): add LspServer process wrapper with fake-server tests"
```

---

### Task 5: LspManager pool and diagnostics cache (manager.ts)

Own the registry, lazy-spawn/pool servers per (language, root), cache diagnostics per URI, and provide the bounded-wait used by the auto-inject hook.

**Files:**
- Create: `src/engine/lsp/manager.ts`
- Test: `tests/lsp/manager.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `ServerConfig` (config.js); `detectLanguage`, `findRoot`, `commandExists`, (detect.js); `LspServer`, `Diagnostic`, `fileUri` (server.js).
- Produces:
  - `class LspManager`:
    - `constructor(registry?: Record<string, ServerConfig>, deps?: { commandExists?: (c: string) => boolean; makeServer?: (cfg: ServerConfig, root: string, onDiag: (uri: string, d: Diagnostic[]) => void) => LspServer })`
    - `serverFor(filePath: string, cwd: string): Promise<LspServer | undefined>` — returns a started server, or `undefined` if no language/available server. Reuses pooled instances.
    - `diagnosticsFor(uri: string): Diagnostic[]`
    - `waitForDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]>` — resolves early when a publish for `uri` lands, else on timeout, returning the current cache.
    - `openFiles(): string[]` — URIs currently in the cache.
    - `shutdown(): void` — stops all servers.
  - Re-export `fileUri` for consumers.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/manager.test.ts
import { describe, it, expect } from "vitest";
import { LspManager } from "../../src/engine/lsp/manager.js";
import { LspServer, fileUri } from "../../src/engine/lsp/server.js";
import { makeFakeServer } from "./fakeServer.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

function makeManager() {
  const created: LspServer[] = [];
  const mgr = new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) => {
      const s = new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any });
      created.push(s);
      return s;
    }
  });
  return { mgr, created };
}

describe("LspManager", () => {
  it("returns undefined for an unknown extension", async () => {
    const { mgr } = makeManager();
    expect(await mgr.serverFor("/x/file.txt", "/x")).toBeUndefined();
  });

  it("returns undefined when the command is not installed", async () => {
    const mgr = new LspManager(DEFAULT_SERVERS, { commandExists: () => false });
    expect(await mgr.serverFor("/x/file.ts", "/x")).toBeUndefined();
  });

  it("pools one server per language+root", async () => {
    const { mgr, created } = makeManager();
    const a = await mgr.serverFor("/x/a.ts", "/x");
    const b = await mgr.serverFor("/x/b.ts", "/x");
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it("caches diagnostics and waits for a publish", async () => {
    const { mgr } = makeManager();
    const server = await mgr.serverFor("/x/a.ts", "/x");
    const uri = fileUri("/x/a.ts");
    server!.didChange(uri, "BAD stuff");
    const diags = await mgr.waitForDiagnostics(uri, 1000);
    expect(diags[0].message).toBe("bad token");
    expect(mgr.openFiles()).toContain(uri);
  });

  it("waitForDiagnostics resolves on timeout with an empty cache", async () => {
    const { mgr } = makeManager();
    await mgr.serverFor("/x/a.ts", "/x");
    const diags = await mgr.waitForDiagnostics(fileUri("/x/clean.ts"), 30);
    expect(diags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/manager.test.ts`
Expected: FAIL — cannot resolve `manager.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/lsp/manager.ts
import { loadRegistry, type ServerConfig } from "./config.js";
import { detectLanguage, findRoot, commandExists as realCommandExists } from "./detect.js";
import { LspServer, fileUri, type Diagnostic } from "./server.js";

export { fileUri };
export type { Diagnostic };

interface Deps {
  commandExists?: (command: string) => boolean;
  makeServer?: (cfg: ServerConfig, root: string, onDiag: (uri: string, d: Diagnostic[]) => void) => LspServer;
}

type Waiter = (diags: Diagnostic[]) => void;

export class LspManager {
  private pool = new Map<string, LspServer>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, Set<Waiter>>();
  private commandExists: (command: string) => boolean;
  private makeServer: NonNullable<Deps["makeServer"]>;

  constructor(
    private registry: Record<string, ServerConfig> = loadRegistry(),
    deps: Deps = {}
  ) {
    this.commandExists = deps.commandExists ?? realCommandExists;
    this.makeServer = deps.makeServer ?? ((cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag));
  }

  async serverFor(filePath: string, cwd: string): Promise<LspServer | undefined> {
    const lang = detectLanguage(filePath, this.registry);
    if (!lang) return undefined;
    const cfg = this.registry[lang];
    if (!this.commandExists(cfg.command)) return undefined;

    const root = findRoot(filePath, cfg.rootMarkers, cwd);
    const key = `${lang}\0${root}`;
    let server = this.pool.get(key);
    if (server && server.alive) return server;

    server = this.makeServer(cfg, root, (uri, diags) => this.onDiagnostics(uri, diags));
    this.pool.set(key, server);
    try {
      await server.start();
    } catch {
      this.pool.delete(key);
      return undefined;
    }
    return server;
  }

  private onDiagnostics(uri: string, diags: Diagnostic[]): void {
    this.diagnostics.set(uri, diags);
    const set = this.waiters.get(uri);
    if (set) {
      for (const w of set) w(diags);
      this.waiters.delete(uri);
    }
  }

  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  openFiles(): string[] {
    return [...this.diagnostics.keys()];
  }

  waitForDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
    return new Promise(resolve => {
      let done = false;
      const finish = (diags: Diagnostic[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(diags);
      };
      const waiter: Waiter = diags => finish(diags);
      let set = this.waiters.get(uri);
      if (!set) { set = new Set(); this.waiters.set(uri, set); }
      set.add(waiter);
      const timer = setTimeout(() => {
        set?.delete(waiter);
        finish(this.diagnosticsFor(uri));
      }, timeoutMs);
    });
  }

  shutdown(): void {
    for (const server of this.pool.values()) server.stop();
    this.pool.clear();
    this.waiters.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lsp/manager.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/lsp/manager.ts tests/lsp/manager.test.ts
git commit -m "feat(lsp): add LspManager pool and diagnostics cache"
```

---

### Task 6: Output formatting (format.ts)

Pure formatting for tool output and the auto-inject diagnostics block.

**Files:**
- Create: `src/engine/lsp/format.ts`
- Test: `tests/lsp/format.test.ts`

**Interfaces:**
- Consumes: `Diagnostic`, `Location` from `server.js`.
- Produces:
  - `formatLocations(locations: Location[], cap: number): string` — one `file:line:col` per line (1-based, URI converted to a path), capped.
  - `formatHover(raw: unknown): string` — extract plain text from LSP hover `contents` (string, `{ value }`, or array), strip basic markdown fences.
  - `formatDiagnosticsBlock(fileLabel: string, diags: Diagnostic[], cap: number): string` — the `--- diagnostics (edited file) ---` block, errors before warnings, capped, with a `(N issues)` footer; empty string when no diags.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/format.test.ts
import { describe, it, expect } from "vitest";
import { formatLocations, formatHover, formatDiagnosticsBlock } from "../../src/engine/lsp/format.js";

describe("formatLocations", () => {
  it("renders 1-based file:line:col and caps", () => {
    const out = formatLocations(
      [{ uri: "file:///a/b.ts", line: 4, column: 2 }, { uri: "file:///a/c.ts", line: 0, column: 0 }],
      1
    );
    expect(out.split("\n")[0]).toMatch(/b\.ts:5:3$/);
    expect(out).toContain("(1 more)");
  });
});

describe("formatHover", () => {
  it("reads a markdown value object", () => {
    expect(formatHover({ contents: { kind: "markdown", value: "const x: number" } })).toBe("const x: number");
  });
  it("reads a plain string", () => {
    expect(formatHover({ contents: "hello" })).toBe("hello");
  });
  it("joins an array of parts", () => {
    expect(formatHover({ contents: ["a", { value: "b" }] })).toBe("a\nb");
  });
});

describe("formatDiagnosticsBlock", () => {
  it("returns empty string when there are no diagnostics", () => {
    expect(formatDiagnosticsBlock("a.ts", [], 10)).toBe("");
  });
  it("orders errors before warnings and caps with a footer", () => {
    const out = formatDiagnosticsBlock("a.ts", [
      { line: 19, column: 0, severity: 2, message: "warn", code: "W1" },
      { line: 11, column: 4, severity: 1, message: "boom", code: "E1" }
    ], 1);
    const lines = out.split("\n");
    expect(lines[0]).toBe("--- diagnostics (edited file) ---");
    expect(lines[1]).toBe("a.ts:12:5 error E1: boom");
    expect(out).toContain("(2 issues)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/format.test.ts`
Expected: FAIL — cannot resolve `format.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/lsp/format.ts
import { fileURLToPath } from "node:url";
import type { Diagnostic, Location } from "./server.js";

function uriToPath(uri: string): string {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

export function formatLocations(locations: Location[], cap: number): string {
  if (locations.length === 0) return "No results.";
  const shown = locations.slice(0, cap)
    .map(l => `${uriToPath(l.uri)}:${l.line + 1}:${l.column + 1}`);
  if (locations.length > cap) shown.push(`(${locations.length - cap} more)`);
  return shown.join("\n");
}

export function formatHover(raw: unknown): string {
  const hover = raw as { contents?: unknown } | null;
  const contents = hover?.contents;
  if (contents == null) return "No hover information.";
  const part = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && "value" in c) return String((c as { value: unknown }).value);
    return "";
  };
  const text = Array.isArray(contents) ? contents.map(part).join("\n") : part(contents);
  return text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim() || "No hover information.";
}

function severityLabel(severity: number): string {
  return severity === 1 ? "error" : severity === 2 ? "warning" : severity === 3 ? "info" : "hint";
}

export function formatDiagnosticsBlock(fileLabel: string, diags: Diagnostic[], cap: number): string {
  if (diags.length === 0) return "";
  const sorted = [...diags].sort((a, b) => a.severity - b.severity || a.line - b.line);
  const lines = sorted.slice(0, cap).map(d => {
    const code = d.code ? `${d.code}: ` : "";
    return `${fileLabel}:${d.line + 1}:${d.column + 1} ${severityLabel(d.severity)} ${code}${d.message}`;
  });
  return [
    "--- diagnostics (edited file) ---",
    ...lines,
    `(${diags.length} issue${diags.length === 1 ? "" : "s"})`
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lsp/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/lsp/format.ts tests/lsp/format.test.ts
git commit -m "feat(lsp): add output formatting for locations, hover, diagnostics"
```

---

### Task 7: Thread LspManager into ToolContext and the engine loop

Give tools access to a shared manager and construct it per session. No behavior change yet — pure wiring, verified by a build.

**Files:**
- Modify: `src/engine/tools/types.ts` (add `lsp?` to `ToolContext`)
- Modify: `src/engine/loop.ts` (add `lsp?` to `EngineOptions`; pass into `execute`; store on instance)
- Modify: `src/agent/session.ts` (construct `LspManager`, pass to loop, shut down on session end)
- Test: `tests/lsp/wiring.test.ts`

**Interfaces:**
- Consumes: `LspManager` from `../lsp/manager.js`.
- Produces: `ToolContext.lsp?: LspManager`; `EngineOptions.lsp?: LspManager`.

- [ ] **Step 1: Add `lsp` to ToolContext**

In `src/engine/tools/types.ts`, extend the interface:

```ts
import type { LspManager } from "../lsp/manager.js";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  lsp?: LspManager;
}
```

- [ ] **Step 2: Thread `lsp` through EngineOptions and runTool**

In `src/engine/loop.ts`:

1. Add to `EngineOptions` (after `store: PermissionStore;`):

```ts
  lsp?: import("./lsp/manager.js").LspManager;
```

2. In `runTool`, change the `execute` call (currently `src/engine/loop.ts:294`) to pass `lsp`:

```ts
      const out = await tool.execute(block.input, { cwd: this.opts.cwd, signal, lsp: this.opts.lsp });
```

- [ ] **Step 3: Construct and shut down the manager in session.ts**

In `src/agent/session.ts`:

1. Add import near the other engine imports:

```ts
import { LspManager } from "../engine/lsp/manager.js";
```

2. Add a private field to `AgentSession` (near `private mcp = new McpManager();`):

```ts
  private lsp = new LspManager();
```

3. In `start()`, pass it into the `EngineLoop` options (add alongside `store,`):

```ts
      lsp: this.lsp,
```

4. Find the session teardown method (the method that aborts/cleans up — search for `abortController` usage or a `stop()`/`dispose()` method). Add `this.lsp.shutdown();` there. If no such method exists, add one:

```ts
  dispose(): void {
    this.abortController?.abort();
    this.lsp.shutdown();
  }
```

Then ensure whatever the CLI calls on exit invokes `dispose()`. Search: `grep -rn "abortController\|\.stop()\|dispose" src/cli.tsx src/agent/session.ts` and wire the existing exit path to call `dispose()`.

- [ ] **Step 4: Write the wiring test**

```ts
// tests/lsp/wiring.test.ts
import { describe, it, expect } from "vitest";
import type { ToolContext } from "../../src/engine/tools/types.js";
import { LspManager } from "../../src/engine/lsp/manager.js";

describe("ToolContext wiring", () => {
  it("accepts an optional LspManager", () => {
    const ctx: ToolContext = { cwd: "/x", lsp: new LspManager() };
    expect(ctx.lsp).toBeInstanceOf(LspManager);
  });
});
```

- [ ] **Step 5: Verify build and tests**

Run: `npm run build && npx vitest run tests/lsp/wiring.test.ts`
Expected: tsc exits 0; test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/tools/types.ts src/engine/loop.ts src/agent/session.ts tests/lsp/wiring.test.ts
git commit -m "feat(lsp): thread LspManager through tool context and session"
```

---

### Task 8: Navigation and Diagnostics tools (tools.ts) and registration

The five agent-facing tools, sharing `ctx.lsp`, plus registration in `builtinTools()`.

**Files:**
- Create: `src/engine/tools/lsp.ts`
- Modify: `src/engine/registry.ts` (register the tools)
- Test: `tests/lsp/tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolContext` (types.js); `LspManager`, `fileUri` (manager.js); `formatLocations`, `formatHover` (format.js).
- Produces: `definitionTool`, `referencesTool`, `hoverTool`, `symbolsTool`, `diagnosticsTool: ToolDef`; each exported and added to `builtinTools()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/tools.test.ts
import { describe, it, expect } from "vitest";
import { definitionTool, hoverTool, diagnosticsTool } from "../../src/engine/tools/lsp.js";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";
import { LspServer } from "../../src/engine/lsp/server.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";
import { makeFakeServer } from "./fakeServer.js";

function mgr() {
  return new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any })
  });
}

describe("Definition tool", () => {
  it("returns a formatted location", async () => {
    const out = await definitionTool.execute(
      { file: "a.ts", line: 3, column: 1 },
      { cwd: "/x", lsp: mgr() }
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/def\.ts:5:3/);
  });

  it("no-ops gracefully without a manager", async () => {
    const out = await definitionTool.execute({ file: "a.ts", line: 1, column: 1 }, { cwd: "/x" });
    expect(out.content).toMatch(/no LSP/i);
    expect(out.isError).toBeFalsy();
  });

  it("no-ops for an unknown extension", async () => {
    const out = await definitionTool.execute({ file: "a.txt", line: 1, column: 1 }, { cwd: "/x", lsp: mgr() });
    expect(out.content).toMatch(/no LSP/i);
  });
});

describe("Hover tool", () => {
  it("returns hover text", async () => {
    const out = await hoverTool.execute({ file: "a.ts", line: 1, column: 1 }, { cwd: "/x", lsp: mgr() });
    expect(out.content).toContain("const");
  });
});

describe("Diagnostics tool", () => {
  it("reports diagnostics for a file after a change", async () => {
    const m = mgr();
    const server = await m.serverFor("/x/a.ts", "/x");
    server!.didChange(fileUri("/x/a.ts"), "BAD");
    await new Promise(r => setTimeout(r, 10));
    const out = await diagnosticsTool.execute({ file: "a.ts" }, { cwd: "/x", lsp: m });
    expect(out.content).toContain("bad token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/tools.test.ts`
Expected: FAIL — cannot resolve `lsp.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/tools/lsp.ts
import { isAbsolute, resolve, extname } from "node:path";
import type { ToolDef, ToolContext } from "./types.js";
import { fileUri, type LspManager } from "../lsp/manager.js";
import { formatLocations, formatHover, formatDiagnosticsBlock } from "../lsp/format.js";
import type { Location } from "../lsp/server.js";

const NAV_CAP = 100;

function absPath(file: string, ctx: ToolContext): string {
  return isAbsolute(file) ? file : resolve(ctx.cwd, file);
}

function noLsp(file: string): string {
  return `No LSP server available for ${extname(file) || file}.`;
}

// Resolve a started server for the file, or return a no-op message.
async function withServer(
  file: string,
  ctx: ToolContext
): Promise<{ server: Awaited<ReturnType<LspManager["serverFor"]>>; uri: string; abs: string } | { message: string }> {
  if (!ctx.lsp) return { message: noLsp(file) };
  const abs = absPath(file, ctx);
  const server = await ctx.lsp.serverFor(abs, ctx.cwd);
  if (!server) return { message: noLsp(file) };
  const uri = fileUri(abs);
  return { server, uri, abs };
}

function toLocations(result: unknown): Location[] {
  const arr = Array.isArray(result) ? result : result ? [result] : [];
  return arr
    .map((r: any) => {
      const range = r.range ?? r.targetRange ?? r.targetSelectionRange;
      const uri = r.uri ?? r.targetUri;
      if (!range || !uri) return undefined;
      return { uri, line: range.start.line, column: range.start.character } as Location;
    })
    .filter((l): l is Location => l !== undefined);
}

const posSchema = {
  file: { type: "string", description: "File path (relative to cwd or absolute)" },
  line: { type: "number", description: "1-based line number" },
  column: { type: "number", description: "1-based column number" }
};

async function ensureOpened(handle: { server: any; uri: string; abs: string }): Promise<void> {
  if (!handle.server.isOpen(handle.uri)) {
    const { readFileSync } = await import("node:fs");
    try {
      handle.server.didOpen(handle.uri, readFileSync(handle.abs, "utf8"));
    } catch {
      handle.server.didOpen(handle.uri, "");
    }
  }
}

export const definitionTool: ToolDef = {
  name: "Definition",
  description: "Find where the symbol at a position is defined, using the language server. Returns file:line:col locations.",
  input_schema: { type: "object", properties: posSchema, required: ["file", "line", "column"] },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    await ensureOpened(h as any);
    const result = await h.server!.request("textDocument/definition", {
      textDocument: { uri: h.uri },
      position: { line: Number(input.line) - 1, character: Number(input.column) - 1 }
    }, ctx.signal);
    return { content: formatLocations(toLocations(result), NAV_CAP) };
  }
};

export const referencesTool: ToolDef = {
  name: "References",
  description: "Find all references to the symbol at a position, using the language server.",
  input_schema: {
    type: "object",
    properties: { ...posSchema, includeDeclaration: { type: "boolean" } },
    required: ["file", "line", "column"]
  },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    await ensureOpened(h as any);
    const result = await h.server!.request("textDocument/references", {
      textDocument: { uri: h.uri },
      position: { line: Number(input.line) - 1, character: Number(input.column) - 1 },
      context: { includeDeclaration: input.includeDeclaration !== false }
    }, ctx.signal);
    return { content: formatLocations(toLocations(result), NAV_CAP) };
  }
};

export const hoverTool: ToolDef = {
  name: "Hover",
  description: "Get type/signature/documentation for the symbol at a position, using the language server.",
  input_schema: { type: "object", properties: posSchema, required: ["file", "line", "column"] },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    await ensureOpened(h as any);
    const result = await h.server!.request("textDocument/hover", {
      textDocument: { uri: h.uri },
      position: { line: Number(input.line) - 1, character: Number(input.column) - 1 }
    }, ctx.signal);
    return { content: formatHover(result) };
  }
};

export const symbolsTool: ToolDef = {
  name: "Symbols",
  description: "List document symbols for a file, or search workspace symbols by query, using the language server.",
  input_schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "File to list symbols for (document symbols)" },
      query: { type: "string", description: "Query for workspace symbol search" }
    }
  },
  async execute(input, ctx) {
    const query = typeof input.query === "string" ? input.query : "";
    const file = typeof input.file === "string" ? input.file : "";
    if (query) {
      // Workspace symbols: need any available server; use the file's language if given, else fail gracefully.
      const probe = file || "x.ts";
      const h = await withServer(probe, ctx);
      if ("message" in h) return { content: h.message };
      const result = await h.server!.request("workspace/symbol", { query }, ctx.signal);
      const locs = (Array.isArray(result) ? result : []).map((s: any) => ({
        uri: s.location.uri, line: s.location.range.start.line, column: s.location.range.start.character
      }));
      return { content: formatLocations(locs, NAV_CAP) };
    }
    const h = await withServer(file, ctx);
    if ("message" in h) return { content: h.message };
    await ensureOpened(h as any);
    const result = await h.server!.request("textDocument/documentSymbol", {
      textDocument: { uri: h.uri }
    }, ctx.signal);
    const locs = (Array.isArray(result) ? result : []).map((s: any) => {
      const range = s.range ?? s.location?.range;
      const uri = s.location?.uri ?? h.uri;
      return { uri, line: range.start.line, column: range.start.character };
    });
    return { content: formatLocations(locs, NAV_CAP) };
  }
};

export const diagnosticsTool: ToolDef = {
  name: "Diagnostics",
  description: "Report compiler/linter diagnostics from the language server for a file, or across all open files.",
  input_schema: {
    type: "object",
    properties: { file: { type: "string", description: "File to check (omit for all open files)" } }
  },
  async execute(input, ctx) {
    if (!ctx.lsp) return { content: "No LSP server available." };
    const file = typeof input.file === "string" ? input.file : "";
    if (file) {
      const h = await withServer(file, ctx);
      if ("message" in h) return { content: h.message };
      await ensureOpened(h as any);
      const diags = await ctx.lsp.waitForDiagnostics(h.uri, 1500);
      const block = formatDiagnosticsBlock(file, diags, 20);
      return { content: block || `No diagnostics for ${file}.` };
    }
    const parts: string[] = [];
    for (const uri of ctx.lsp.openFiles()) {
      const block = formatDiagnosticsBlock(uri, ctx.lsp.diagnosticsFor(uri), 20);
      if (block) parts.push(block);
    }
    return { content: parts.length ? parts.join("\n\n") : "No diagnostics." };
  }
};
```

- [ ] **Step 4: Register the tools**

Replace `src/engine/registry.ts` with:

```ts
import type { ToolDef } from "./tools/types.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { bashTool } from "./tools/bash.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool } from "./tools/lsp.js";

export function builtinTools(): ToolDef[] {
  return [
    readTool, writeTool, editTool, bashTool, globTool, grepTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool
  ];
}
```

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run tests/lsp/tools.test.ts && npm run build`
Expected: test PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/tools/lsp.ts src/engine/registry.ts tests/lsp/tools.test.ts
git commit -m "feat(lsp): add Definition/References/Hover/Symbols/Diagnostics tools"
```

---

### Task 9: Auto-inject diagnostics after Edit/Write

After a successful `Edit`/`Write`, push the new file contents to the language server and append a diagnostics block to the tool result.

**Files:**
- Modify: `src/engine/loop.ts` (`runTool`)
- Test: `tests/lsp/autoInject.test.ts`

**Interfaces:**
- Consumes: `LspManager`, `fileUri` (manager.js); `formatDiagnosticsBlock` (format.js).
- Produces: no new exports — behavior change to `runTool` only.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/autoInject.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { appendDiagnostics } from "../../src/engine/lsp/autoInject.js";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";
import { LspServer } from "../../src/engine/lsp/server.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";
import { makeFakeServer } from "./fakeServer.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mgr() {
  return new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any })
  });
}

describe("appendDiagnostics", () => {
  it("appends a diagnostics block for an edited file with issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "BAD code", "utf8");
    const out = await appendDiagnostics("Edit", { file_path: file }, "edited a.ts", mgr(), dir);
    expect(out).toContain("edited a.ts");
    expect(out).toContain("bad token");
  });

  it("returns the original content unchanged for a clean file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "clean", "utf8");
    const out = await appendDiagnostics("Write", { file_path: file }, "wrote a.ts", mgr(), dir);
    expect(out).toBe("wrote a.ts");
  });

  it("passes through non-edit tools untouched", async () => {
    const out = await appendDiagnostics("Grep", {}, "matches", mgr(), "/x");
    expect(out).toBe("matches");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/autoInject.test.ts`
Expected: FAIL — cannot resolve `autoInject.js`.

- [ ] **Step 3: Write the helper**

```ts
// src/engine/lsp/autoInject.ts
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, basename } from "node:path";
import { fileUri, type LspManager } from "./manager.js";
import { formatDiagnosticsBlock } from "./format.js";

const EDIT_TOOLS = new Set(["Edit", "Write"]);
const WAIT_MS = 1500;
const CAP = 10;

export async function appendDiagnostics(
  toolName: string,
  input: Record<string, unknown>,
  content: string,
  lsp: LspManager | undefined,
  cwd: string
): Promise<string> {
  if (!lsp || !EDIT_TOOLS.has(toolName)) return content;
  const file = typeof input.file_path === "string" ? input.file_path : "";
  if (!file) return content;
  const abs = isAbsolute(file) ? file : resolve(cwd, file);

  const server = await lsp.serverFor(abs, cwd);
  if (!server) return content;
  const uri = fileUri(abs);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return content;
  }
  server.didChange(uri, text);
  const diags = await lsp.waitForDiagnostics(uri, WAIT_MS);
  const block = formatDiagnosticsBlock(basename(abs), diags, CAP);
  return block ? `${content}\n\n${block}` : content;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lsp/autoInject.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into runTool**

In `src/engine/loop.ts`, in `runTool`, replace the success branch (currently `src/engine/loop.ts:294-295`):

```ts
      const out = await tool.execute(block.input, { cwd: this.opts.cwd, signal, lsp: this.opts.lsp });
      const content = await appendDiagnostics(block.name, block.input, out.content, this.opts.lsp, this.opts.cwd);
      return { type: "tool_result", tool_use_id: block.id, content, is_error: out.isError === true };
```

Add the import at the top of `src/engine/loop.ts` with the other imports:

```ts
import { appendDiagnostics } from "./lsp/autoInject.js";
```

- [ ] **Step 6: Verify build and full test run**

Run: `npm run build && npm run test`
Expected: tsc exits 0; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/lsp/autoInject.ts src/engine/loop.ts tests/lsp/autoInject.test.ts
git commit -m "feat(lsp): auto-inject diagnostics after Edit/Write"
```

---

### Task 10: Doctor report section and optional real-server smoke test

Surface which LSP servers are detected/installed in `cloudcode doctor`, and add a guarded integration test.

**Files:**
- Modify: `src/commands/cli/doctor.ts` (add a `checkLspServers` function and include it in `runDoctor`)
- Test: `tests/lsp/doctor.test.ts`
- Test: `tests/lsp/integration.test.ts` (guarded, skipped without a real server)

**Interfaces:**
- Consumes: `loadRegistry` (config.js); `commandExists` (detect.js); `DoctorCheck` (doctor.ts).
- Produces: `checkLspServers(registry?, exists?): DoctorCheck[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lsp/doctor.test.ts
import { describe, it, expect } from "vitest";
import { checkLspServers } from "../../src/commands/cli/doctor.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

describe("checkLspServers", () => {
  it("reports ok for installed and not-ok for missing servers", () => {
    const checks = checkLspServers(DEFAULT_SERVERS, cmd => cmd === "gopls");
    const go = checks.find(c => c.name.includes("go"));
    const ts = checks.find(c => c.name.includes("typescript"));
    expect(go?.ok).toBe(true);
    expect(ts?.ok).toBe(false);
    expect(ts?.detail).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/doctor.test.ts`
Expected: FAIL — `checkLspServers` is not exported.

- [ ] **Step 3: Implement checkLspServers and include it in runDoctor**

In `src/commands/cli/doctor.ts`, add near the other check functions:

```ts
import { loadRegistry, type ServerConfig } from "../../engine/lsp/config.js";
import { commandExists as realCommandExists } from "../../engine/lsp/detect.js";

export function checkLspServers(
  registry: Record<string, ServerConfig> = loadRegistry(),
  exists: (command: string) => boolean = realCommandExists
): DoctorCheck[] {
  return Object.entries(registry).map(([lang, cfg]) => {
    const ok = exists(cfg.command);
    return {
      name: `lsp:${lang}`,
      ok,
      detail: ok ? `${cfg.command} found` : `${cfg.command} not found on PATH`
    };
  });
}
```

Then in `runDoctor` (the function that assembles the check array, near `src/commands/cli/doctor.ts:65`), spread the LSP checks into the returned list, e.g. add `...checkLspServers(),` alongside the existing checks. (Read the function body first to match its exact assembly style — it may push into an array or build a literal.)

- [ ] **Step 4: Add the guarded integration test**

```ts
// tests/lsp/integration.test.ts
import { describe, it, expect } from "vitest";
import { commandExists } from "../../src/engine/lsp/detect.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";

const hasTs = commandExists("typescript-language-server");

describe.skipIf(!hasTs)("real typescript-language-server", () => {
  it("produces a diagnostic for a type error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-int-"));
    writeFileSync(join(dir, "package.json"), "{}", "utf8");
    const file = join(dir, "a.ts");
    writeFileSync(file, "const x: number = 'nope';\n", "utf8");
    const mgr = new LspManager();
    const server = await mgr.serverFor(file, dir);
    expect(server).toBeDefined();
    server!.didOpen(fileUri(file), "const x: number = 'nope';\n");
    const diags = await mgr.waitForDiagnostics(fileUri(file), 8000);
    mgr.shutdown();
    expect(diags.length).toBeGreaterThan(0);
  }, 15000);
});
```

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run tests/lsp/doctor.test.ts tests/lsp/integration.test.ts && npm run build`
Expected: doctor test PASS; integration test PASS or SKIPPED (depending on whether `typescript-language-server` is installed); tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/cli/doctor.ts tests/lsp/doctor.test.ts tests/lsp/integration.test.ts
git commit -m "feat(lsp): report LSP server availability in doctor; add smoke test"
```

---

### Task 11: Documentation and final verification

Document LSP in the README and run the full gate.

**Files:**
- Modify: `README.md` (add an "LSP support" section)

- [ ] **Step 1: Add a README section**

Add after the "Local models" section (adjust heading placement to match the file):

```markdown
## LSP support

cloudcode can use language servers for semantic navigation and diagnostics. It
ships known configs for TypeScript/JavaScript (`typescript-language-server`),
Python (`pyright-langserver`), Rust (`rust-analyzer`), and Go (`gopls`), and
auto-detects which apply from the files you edit. A server is only used if its
command is on your `PATH` — otherwise LSP features quietly no-op.

The agent gains `Definition`, `References`, `Hover`, `Symbols`, and
`Diagnostics` tools, and diagnostics for a file are appended automatically after
it edits that file.

Override or add servers in `~/.cloudcode/lsp.json` (or project-local
`.cloudcode/lsp.json`):

    {
      "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
      "elixir": { "extensions": [".ex", ".exs"], "command": "elixir-ls", "rootMarkers": ["mix.exs"] }
    }

Disable a built-in with `{ "go": { "enabled": false } }`. Run `cloudcode doctor`
to see which servers were found.
```

- [ ] **Step 2: Run the full verification gate**

Run: `npm run lint && npm run build && npm run test`
Expected: oxlint clean; tsc exits 0; all tests PASS (integration test may be skipped).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document LSP support and lsp.json configuration"
```

---

## Self-Review Notes

- **Spec coverage:** architecture (Tasks 4-7, 9), registry+config with project/user precedence (Task 2), detection+PATH availability (Task 3), LspServer protocol/lifecycle/document sync (Task 4), diagnostics cache + bounded wait (Task 5), all five tools + graceful no-op (Task 8), auto-inject after Edit/Write (Task 9), doctor section (Task 10), TDD + fake server + guarded integration test (throughout, Task 10), README (Task 11). All spec sections map to tasks.
- **Type consistency:** `LspServer` / `LspManager` / `ServerConfig` / `Diagnostic` / `Location` signatures are declared once (Tasks 2, 4, 5) and reused verbatim by later tasks; `fileUri` exported from `server.ts` and re-exported from `manager.ts`; `serverFor(filePath, cwd)`, `waitForDiagnostics(uri, timeoutMs)`, `diagnosticsFor(uri)`, `openFiles()` used consistently in Tasks 8-10.
- **Note for the implementer:** Tasks 7 and 10 touch existing files (`session.ts`, `doctor.ts`) whose exact structure should be read first; the plan flags the specific insertion points and says to match the file's existing assembly style rather than assuming a shape.
