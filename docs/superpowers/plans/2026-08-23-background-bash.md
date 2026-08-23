# Background Bash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model can start long-running shell commands with `Bash { run_in_background: true }`, read incremental output via `BashOutput`, and terminate via `KillShell`; shells live for the session (max 10) and are killed on dispose.

**Architecture:** A `BackgroundShellManager` in `src/engine/tools/backgroundShells.ts` owns spawned processes with per-shell ring buffers, injected through the established registry/ToolContext patterns (`bgShells` option). Bash delegates when `run_in_background` is set; `BashOutput`/`KillShell` are registered only when a manager exists; session dispose calls `killAll()`.

**Tech Stack:** TypeScript (strict), `child_process.spawn`, vitest with injectable fake children.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-23-background-bash-design.md`.
- All code/comments in English only.
- tsconfig stays strict; no `any`, no non-null assertions.
- Limits: max **10** concurrent shells; **200 KB** ring buffer per shell with `[earlier output dropped]` marker.
- Foreground Bash behavior must not change; background shells survive turn interrupts but not dispose/resume.
- Only pre-existing lint warnings allowed; tests land in the same commit as code.

---

### Task 1: `BackgroundShellManager`

**Files:**
- Create: `src/engine/tools/backgroundShells.ts`
- Test: `tests/background-shells.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ChildLike {
    pid?: number;
    stdout: AsyncIterable<Buffer> | null;
    stderr: AsyncIterable<Buffer> | null;
    kill(): void;
  }
  export type BgSpawner = (command: string, cwd: string) => ChildLike;
  export class BackgroundShellManager {
    constructor(spawner: BgSpawner)
    start(command: string, cwd: string): { id?: string; error?: string };
    read(id: string): string | undefined;   // undefined = unknown id
    status(id: string): "running" | "exited" | undefined;
    exitCode(id: string): number | undefined;
    kill(id: string): Promise<string | undefined>;
    count(): number;
    ids(): string[];
    killAll(): void;
  }
  ```
  Real spawner factory: `realBgSpawner(command, cwd): ChildLike` using `spawn` + same shell selection as bash.ts.

- [ ] **Step 1: Write the failing test**

Create `tests/background-shells.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { BackgroundShellManager, type ChildLike } from "../src/engine/tools/backgroundShells.js";

// Scriptable fake child: stdout/stderr are event emitters the manager pumps.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & ChildLike;
  let outHandler: ((chunk: Buffer) => void) | undefined;
  const stdout = {
    on: (_e: string, h: (c: Buffer) => void) => { outHandler = h; }
  };
  Object.assign(child, { stdout, stderr: stdout, kill: () => { child.emit("exit", 1, "SIGTERM"); } });
  return {
    child,
    write(chunk: string) { outHandler?.(Buffer.from(chunk)); },
    exit(code: number) { child.emit("exit", code, null); }
  };
}

function managerWith(children: ReturnType<typeof fakeChild>[]) {
  return new BackgroundShellManager(command => {
    const fc = fakeChild();
    children.push(fc);
    return fc.child as ChildLike;
  });
}

describe("BackgroundShellManager", () => {
  it("assigns sequential ids and counts", () => {
    const mgr = managerWith([]);
    const r1 = mgr.start("server", "/tmp");
    const r2 = mgr.start("watcher", "/tmp");
    expect(r1.id).toBe("b1");
    expect(r2.id).toBe("b2");
    expect(mgr.count()).toBe(2);
  });

  it("accumulates output and reads incrementally", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("line one\n");
    children[0].write("line two\n");
    expect(mgr.read("b1")).toContain("line one");
    expect(mgr.read("b1")).toContain("line two");
    // Already consumed: next read returns nothing new.
    expect(mgr.read("b1")).toBe("");
    children[0].write("line three\n");
    expect(mgr.read("b1")).toContain("line three");
  });

  it("reports exit codes in status after exit fires", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].exit(7);
    expect(mgr.status("b1")).toBe("exited");
    expect(mgr.exitCode("b1")).toBe(7);
  });

  it("kills a shell, frees its slot, and reports remaining output", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("partial\n");
    const out = await mgr.kill("b1");
    expect(out).toContain("partial");
    expect(mgr.status("b1")).toBe("exited");
    expect(mgr.count()).toBe(0);
  });

  it("rejects starts beyond the cap of 10", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    for (let i = 0; i < 10; i++) mgr.start(`cmd${i}`, "/tmp");
    expect(mgr.start("extra", "/tmp").error).toBeDefined();
    expect(mgr.count()).toBe(10);
  });

  it("drops oldest output beyond the ring size and marks it", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("x".repeat(300 * 1024));
    const all = mgr.read("b1");
    expect(all.length).toBeLessThanOrEqual(200 * 1024 + "[earlier output dropped]".length);
    expect(all.startsWith("[earlier output dropped]")).toBe(true);
  });

  it("killAll terminates everything", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("a", "/tmp");
    mgr.start("b", "/tmp");
    await Promise.resolve();
    mgr.killAll();
    expect(mgr.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background-shells.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/engine/tools/backgroundShells.ts`:

```ts
import { spawn } from "node:child_process";

export interface ChildLike {
  pid?: number;
  stdout: { on(event: string, handler: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: string, handler: (chunk: Buffer) => void): void } | null;
  kill(): void;
}

export type BgSpawner = (command: string, cwd: string) => ChildLike;

const MAX_SHELLS = 10;
const RING_BYTES = 200 * 1024;

/** Fixed-capacity byte ring; readNew drains what was appended since last read. */
class Ring {
  private buf = Buffer.alloc(0);
  private dropped = false;
  append(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > RING_BYTES) {
      this.buf = this.buf.subarray(this.buf.length - RING_BYTES);
      this.dropped = true;
    }
  }
  drain(): string {
    const text = this.buf.toString("utf8");
    this.buf = Buffer.alloc(0);
    if (text === "") return "";
    return (this.dropped ? "[earlier output dropped]" : "") + text;
  }
}

interface Shell {
  id: string;
  child: ChildLike;
  ring: Ring;
  running: boolean;
  exitCode?: number;
}

export function realBgSpawner(command: string, cwd: string): ChildLike {
  const shell = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
    : spawn("/bin/sh", ["-c", command], { cwd });
  return shell as unknown as ChildLike;
}

/**
 * Owns every background shell of a session: sequential b1..bn ids, capped
 * concurrency, per-shell ring buffers, and bulk teardown at dispose.
 */
export class BackgroundShellManager {
  private shells = new Map<string, Shell>();
  private seq = 0;
  private dead = new Set<string>(); // ids killed or exited, kept for one final read

  constructor(private spawner: BgSpawner) {}

  start(command: string, cwd: string): { id?: string; error?: string } {
    const liveCount = [...this.shells.values()].filter(s => s.running).length;
    if (liveCount >= MAX_SHELLS) {
      return { error: `Already ${MAX_SHELLS} background shells running; kill one with KillShell first.` };
    }
    this.seq += 1;
    const id = `b${this.seq}`;
    try {
      const child = this.spawner(command, cwd);
      const shell: Shell = { id, child, ring: new Ring(), running: true };
      const onData = (chunk: Buffer) => shell.ring.append(chunk);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      // Exit handling is attached by callers that need it; track via kill/exit
      // events uniformly below.
      const anyChild = child as unknown as { on?(event: string, h: (...a: unknown[]) => void): void };
      anyChild.on?.("exit", (code: unknown) => {
        shell.running = false;
        shell.exitCode = typeof code === "number" ? code : undefined;
      });
      this.shells.set(id, shell);
      return { id };
    } catch (err) {
      this.seq -= 1;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private get(id: string): Shell | undefined {
    return this.shells.get(id);
  }

  /** Drains new output since the last read; undefined for unknown ids. */
  read(id: string): string | undefined {
    const shell = this.get(id);
    if (!shell) return undefined;
    return shell.ring.drain();
  }

  status(id: string): "running" | "exited" | undefined {
    const shell = this.get(id);
    if (!shell) return undefined;
    return shell.running ? "running" : "exited";
  }

  exitCode(id: string): number | undefined {
    return this.get(id)?.exitCode;
  }

  count(): number {
    return [...this.shells.values()].filter(s => s.running).length;
  }

  ids(): string[] {
    return [...this.shells.keys()];
  }

  async kill(id: string): Promise<string | undefined> {
    const shell = this.get(id);
    if (!shell) return undefined;
    const remaining = shell.ring.drain();
    if (shell.running) {
      shell.child.kill();
      shell.running = false;
    }
    this.shells.delete(id);
    return `${remaining}Background shell ${id} killed.`.trim();
  }

  killAll(): void {
    for (const id of [...this.shells.keys()]) void this.kill(id);
  }
}
```

Implementer notes:
- The test's fake child uses EventEmitters; the manager's `stdout.on("data")` wiring works against them directly.
- The `dead` field in the sketch above proved unnecessary — remove it if present.
- `kill()` on an already-exited shell still returns remaining output and deletes the entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/background-shells.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/backgroundShells.ts tests/background-shells.test.ts
git commit -m "feat(tools): background shell manager with ring-buffer output"
```

---

### Task 2: Wire the suite — Bash flag, BashOutput, KillShell

**Files:**
- Modify: `src/engine/tools/bash.ts`
- Create: `src/engine/tools/bashOut.ts`
- Modify: `src/engine/tools/types.ts` (ToolContext gains `bgShells?`)
- Modify: `src/engine/loop.ts` (EngineOptions + ToolContext plumbing)
- Modify: `src/engine/registry.ts`
- Test: `tests/engine-bg-bash.test.ts`

**Interfaces:**
- Consumes: `BackgroundShellManager` (Task 1).
- Produces:
  - `Bash.input_schema` gains `run_in_background?: boolean`; execute honors it via `ctx.bgShells`.
  - `createBashOutputTool(mgr)` / `createKillShellTool(mgr)` — tools named `"BashOutput"` / `"KillShell"`.
  - `builtinTools(options)` gains `bgShells?: BackgroundShellManager`.
  - `decidePermission` returns `"allow"` unconditionally for `BashOutput`/`KillShell`.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-bg-bash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bashTool } from "../src/engine/tools/bash.js";
import { createBashOutputTool, createKillShellTool } from "../src/engine/tools/bashOut.js";
import { builtinTools } from "../src/engine/registry.js";
import { decidePermission } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore() {
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-bgbash-")));
}

describe("background bash tools", () => {
  it("permissions: BashOutput/KillShell always allowed, Bash unchanged", () => {
    const store = freshStore();
    expect(decidePermission("BashOutput", {}, "default", store, "/p")).toBe("allow");
    expect(decidePermission("KillShell", { id: "b1" }, "default", store, "/p")).toBe("allow");
    expect(decidePermission("Bash", { command: "ls" }, "default", store, "/p")).toBe("ask");
  });

  it("registry registers output/kill tools only when bgShells provided", () => {
    expect(builtinTools().map(t => t.name)).not.toContain("BashOutput");
    const names = builtinTools({ bgShells: {} as never }).map(t => t.name);
    expect(names).toContain("BashOutput");
    expect(names).toContain("KillShell");
  });
});
```

```ts
import { EventEmitter } from "node:events";
import type { ChildLike } from "../src/engine/tools/backgroundShells.js";

function fakeChildLocal() {
  const child = new EventEmitter() as EventEmitter & ChildLike;
  let outHandler: ((chunk: Buffer) => void) | undefined;
  const stdout = { on: (_e: string, h: (c: Buffer) => void) => { outHandler = h; } };
  Object.assign(child, { stdout, stderr: stdout, kill: () => { child.emit("exit", 1, "SIGTERM"); } });
  return {
    child: child as ChildLike,
    write(chunk: string) { outHandler?.(Buffer.from(chunk)); },
    exit(code: number) { child.emit("exit", code, null); }
  };
}
type FakeChildHolder = ReturnType<typeof fakeChildLocal>;

describe("Bash run_in_background flow", () => {
  const ctxBase = (mgr: BackgroundShellManager) => ({ cwd: "/tmp", bgShells: mgr });

  it("starts a shell and returns its id immediately", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = new BackgroundShellManager(() => {
      const fc = fakeChildLocal();
      locals.push(fc);
      return fc.child;
    });
    const out = await bashTool.execute({ command: "npm run dev", run_in_background: true }, ctxBase(mgr));
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("id: b1");
    expect(out.content).toContain("BashOutput");
    expect(locals).toHaveLength(1);
  });

  it("BashOutput reads new output and reports running status", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = new BackgroundShellManager(() => {
      const fc = fakeChildLocal();
      locals.push(fc);
      return fc.child;
    });
    await bashTool.execute({ command: "server", run_in_background: true }, ctxBase(mgr));
    await Promise.resolve();
    locals[0].write("listening on 3000\n");
    const outTool = createBashOutputTool(mgr);
    const out = await outTool.execute({ id: "b1" }, { cwd: "/tmp" });
    expect(out.content).toContain("listening on 3000");
    expect(out.content).toContain("running");
  });

  it("unknown ids produce error results", async () => {
    const mgr = new BackgroundShellManager(() => fakeChildLocal().child);
    const out = await createBashOutputTool(mgr).execute({ id: "nope" }, { cwd: "/tmp" });
    expect(out.isError).toBe(true);
  });

  it("KillShell terminates and frees the slot", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = new BackgroundShellManager(() => {
      const fc = fakeChildLocal();
      locals.push(fc);
      return fc.child;
    });
    await bashTool.execute({ command: "server", run_in_background: true }, ctxBase(mgr));
    const out = await createKillShellTool(mgr).execute({ id: "b1" }, { cwd: "/tmp" });
    expect(out.content).toContain("killed");
    expect(mgr.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-bg-bash.test.ts`
Expected: FAIL — no run_in_background support, no tools exported.

- [ ] **Step 3: Implement**

(a) In `src/engine/tools/bash.ts`:

```ts
import type { BackgroundShellManager } from "./backgroundShells.js";
```

Add to input_schema properties:

```ts
      run_in_background: { type: "boolean", description: "Start without waiting; read output later with BashOutput" }
```

At the top of `execute`:

```ts
    if (input.run_in_background === true && ctx.bgShells) {
      const started = ctx.bgShells.start(String(input.command ?? ""), ctx.cwd);
      if (started.error || !started.id) {
        return { content: `Cannot start background shell: ${started.error ?? "unknown error"}`, isError: true };
      }
      return {
        content: `Shell started in background (id: ${started.id}). Use BashOutput to read its output; KillShell to stop it.`
      };
    }
```

(b) In `src/engine/tools/types.ts`, add to `ToolContext`:

```ts
  /** Session-owned background shell manager (for Bash run_in_background). */
  bgShells?: import("./backgroundShells.js").BackgroundShellManager;
```

(c) Create `src/engine/tools/bashOut.ts`:

```ts
import type { ToolDef } from "./types.js";
import type { BackgroundShellManager } from "./backgroundShells.js";

export function createBashOutputTool(mgr: BackgroundShellManager): ToolDef {
  return {
    name: "BashOutput",
    description: "Read new output from a background shell started with Bash run_in_background.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Shell id, e.g. b1" } },
      required: ["id"]
    },
    async execute(input) {
      const id = String(input.id ?? "");
      const output = mgr.read(id);
      if (output === undefined) return { content: `Unknown background shell: ${id}`, isError: true };
      const status = mgr.status(id) ?? "exited";
      const code = mgr.exitCode(id);
      const body = output === "" ? "(no new output)" : output;
      return { content: `[${status}${status === "exited" && code !== undefined ? ` (${code})` : ""}]\n${body}` };
    }
  };
}

export function createKillShellTool(mgr: BackgroundShellManager): ToolDef {
  return {
    name: "KillShell",
    description: "Terminate a background shell started with Bash run_in_background.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Shell id, e.g. b1" } },
      required: ["id"]
    },
    async execute(input) {
      const result = await mgr.kill(String(input.id ?? ""));
      if (result === undefined) return { content: `Unknown background shell: ${String(input.id ?? "")}`, isError: true };
      return { content: result || "Background shell killed." };
    }
  };
}
```

(d) In `src/engine/loop.ts`: `EngineOptions` gains

```ts
  bgShells?: import("./tools/backgroundShells.js").BackgroundShellManager;
```

and `runTool`'s ToolContext gains `bgShells: this.opts.bgShells`.

(e) In `src/engine/registry.ts`: options gain `bgShells?: BackgroundShellManager` (import the type plus both factories); array tail becomes:

```ts
    ...(options.task ? [createTaskTool(options.task)] : []),
    createTodoTool(options.todoStore),
    ...(options.bgShells ? [createBashOutputTool(options.bgShells), createKillShellTool(options.bgShells)] : [])
```

(f) In `src/engine/permissions.ts`, right after the TodoWrite allow:

```ts
  // BashOutput/KillShell only touch state from an already-approved background
  // command, so they never prompt in any mode.
  if (toolName === "BashOutput" || toolName === "KillShell") return "allow";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-bg-bash.test.ts tests/background-shells.test.ts tests/engine-permissions.test.ts tests/session.test.ts tests/printMode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/bash.ts src/engine/tools/bashOut.ts src/engine/tools/types.ts src/engine/tools/backgroundShells.ts src/engine/loop.ts src/engine/registry.ts src/engine/permissions.ts tests/engine-bg-bash.test.ts
git commit -m "feat(tools): background Bash with BashOutput and KillShell"
```

---

### Task 3: Session wiring

**Files:**
- Modify: `src/agent/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `BackgroundShellManager` (Task 1).
- Produces: one manager per session; `dispose()` kills everything.

- [ ] **Step 1: Write the failing test**

Append to `tests/session.test.ts`:

```ts
describe("AgentSession background shells", () => {
  it("creates a manager whose killAll runs on dispose", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([[textTurn("ok")]]));
    const session = new AgentSession({
      providerName: "local", provider: { kind: "openai", baseUrl: "http://127.0.0.1:8080" },
      permissionMode: "default", networkMode: "offlineStrict",
      cwd: mkdtempSync(join(tmpdir(), "cc-sess-bg-")),
      onMessage: () => {}, onPermissionRequest: () => {}, onSessionId: () => {}
    });
    session.start();
    expect(session.tools).toContain("BashOutput");
    expect(session.tools).toContain("KillShell");
    await session.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts -t "background shells"`
Expected: FAIL — tools absent.

- [ ] **Step 3: Implement**

In `src/agent/session.ts`:

(a) Import:

```ts
import { BackgroundShellManager } from "../engine/tools/backgroundShells.js";
```

(b) In `start()`, near `todoStore` construction:

```ts
    const bgShells = new BackgroundShellManager(realBgSpawner);
```

with `import { BackgroundShellManager, realBgSpawner } from "../engine/tools/backgroundShells.js";` merged into (a).

(c) Add `bgShells,` to the `builtinTools({...})` call and `bgShells,` to the `new EngineLoop({...})` options.

(d) In `dispose()`, before `await this.mcp.dispose();`:

```ts
    bgShellsAccess?.killAll();
```



- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts tests/printMode.test.ts tests/app.test.ts tests/cliTask.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts tests/session.test.ts
git commit -m "feat(agent): per-session background shell lifecycle"
```

---

### Task 4: Full verification

**Files:** none created; verification only.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 2: Lint and size check**

Run: `npm run lint ; npm run lint:size`
Expected: only pre-existing warnings.

- [ ] **Step 3: Whole suite on current Node AND Node 20**

Run: `npm test` then `npx -y node@20 node_modules/vitest/vitest.mjs run`
Expected: all suites pass on both.

- [ ] **Step 4: Manual smoke check (optional)**

Run `npm run dev`, ask the model to "start a dev server in the background and check its output". Expect: immediate id response, incremental logs via BashOutput, clean termination via KillShell.

- [ ] **Step 5: Commit stragglers**

```bash
git status
```

Expected: clean tree.
