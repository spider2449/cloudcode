# Sandbox Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `offlineStrict` is active on Linux, `Bash` becomes available through a verified no-network sandbox (`unshare -n` / `bwrap`) instead of being unconditionally disabled.

**Architecture:** New `src/agent/sandbox.ts` probes once per process for a working netns sandbox and exposes an adapter whose `wrap()` rewrites shell commands to run inside it. The adapter flows through the existing `verifiedNoNetworkSandbox` seam into tool context; Bash and background shells route every spawn through it. CLI/doctor/status surfaces report the real result.

**Tech Stack:** TypeScript (strict), Node `child_process.spawnSync`/`execFile`/`spawn`, vitest.

## Global Constraints

- All code, comments, identifiers in English.
- `tsconfig.json` stays `"strict": true`; no `any`, no non-null `!`.
- No file in `src/` over ~600 lines (`npm run lint:size`).
- Engine files must not import agent-layer classes by value — tool-context fields are structural types (see existing `networkPolicy` field comment in `src/engine/tools/types.ts`).
- Every production module gets a focused test file in the same commit.
- Fail closed: any probe uncertainty means "no sandbox"; never fall back to unwrapped execution.
- Sandbox wrapping applies **only** under `offlineStrict`. Under `providerOnly`/`unrestricted`, commands must NOT be wrapped (they may need network).
- After each task: `npx vitest run <affected tests>`; after all tasks: `npm run lint && npm run lint:size && npm run build && npm test`.

---

### Task 1: Sandbox probe module

**Files:**
- Create: `src/agent/sandbox.ts`
- Test: `tests/sandbox.test.ts`

**Interfaces:**
- Consumes: nothing (only `node:child_process`).
- Produces (used by Tasks 2–4):
  - `interface SandboxAdapter { readonly kind: "netns"; wrap(command: string): { cmd: string; args: string[] }; }`
  - `type SandboxProbeResult = { available: true; adapter: SandboxAdapter } | { available: false; reason: string };`
  - `type SandboxRunner = (cmd: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string };`
  - `function probeSandbox(runner?: SandboxRunner, platform?: string): SandboxProbeResult`
  - `function probeSandboxCached(): SandboxProbeResult` and `function resetSandboxCacheForTests(): void`
  - `function sandboxEnablesBash(mode: NetworkMode): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/sandbox.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  probeSandbox, probeSandboxCached, resetSandboxCacheForTests,
  type SandboxRunner
} from "../src/agent/sandbox.js";

const PROBE = 'for i in /sys/class/net/*; do printf "%s %s\\n" "${i##*/}" "$(cat "$i/operstate")"; done';

function runnerWith(results: Record<string, { status: number | null; stdout: string }>): SandboxRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = results[key];
    if (!hit) throw new Error(`unexpected invocation: ${key}`);
    return hit;
  };
}
const unshareRun = (status: number | null, stdout: string) => ({
  [`unshare -n /bin/sh -c ${PROBE}`]: { status, stdout }
});
const bwrapRun = (status: number | null, stdout: string) => ({
  [`bwrap --unshare-net --dev-bind / / /bin/sh -c ${PROBE}`]: { status, stdout }
});

describe("probeSandbox", () => {
  beforeEach(() => resetSandboxCacheForTests());

  it("is unavailable on Windows", () => {
    const r = probeSandbox(runnerWith({}), "win32");
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("Linux");
  });

  it("verifies unshare when only lo exists and is down", () => {
    const r = probeSandbox(runnerWith(unshareRun(0, "lo down\n")), "linux");
    expect(r.available).toBe(true);
    if (r.available) expect(r.adapter.kind).toBe("netns");
  });

  it("falls back to bwrap when unshare is missing, and verifies it", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(0, "lo down\n") }),
      "linux"
    );
    expect(r.available).toBe(true);
  });

  it("reports unavailable when neither candidate exists or passes", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(1, "") }),
      "linux"
    );
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("sandbox");
  });

  it("rejects extra interfaces besides lo", () => {
    const results = {
      ...unshareRun(0, "lo down\neth0 up\n"),
      ...bwrapRun(0, "lo down\neth0 up\n")
    };
    const r = probeSandbox(runnerWith(results), "linux");
    expect(r.available).toBe(false);
  });

  it("rejects lo being up", () => {
    const results = { ...unshareRun(0, "lo up\n"), ...bwrapRun(0, "lo up\n") };
    const r = probeSandbox(runnerWith(results), "linux");
    expect(r.available).toBe(false);
  });
});

describe("adapters", () => {
  it("wraps commands with unshare as an argument array", () => {
    const r = probeSandbox(runnerWith(unshareRun(0, "lo down\n")), "linux");
    if (!r.available) throw new Error("expected available");
    expect(r.adapter.wrap("echo hi")).toEqual({
      cmd: "unshare", args: ["-n", "/bin/sh", "-c", "echo hi"]
    });
  });

  it("wraps commands with bwrap when bwrap won", () => {
    const r = probeSandbox(
      runnerWith({ ...unshareRun(null, ""), ...bwrapRun(0, "lo down\n") }),
      "linux"
    );
    if (!r.available) throw new Error("expected available");
    expect(r.adapter.wrap("echo hi")).toEqual({
      cmd: "bwrap",
      args: ["--unshare-net", "--dev-bind", "/", "/", "/bin/sh", "-c", "echo hi"]
    });
  });
});

describe("probeSandboxCached", () => {
  it("runs the underlying probe once", () => {
    let calls = 0;
    const runner: SandboxRunner = () => { calls += 1; return { status: null, stdout: "" }; };
    resetSandboxCacheForTests();
    // The cache is process-global; both calls share one probe.
    const a = probeSandboxCached();
    const b = probeSandboxCached();
    expect(b).toBe(a);
    void runner; void calls;
  });
});
```

Note: the last test asserts identity caching without depending on platform. On Windows the cached value is the win32 result; on Linux with no sandbox tools present the probe returns unavailable — either way two calls return the same object.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sandbox.test.ts`
Expected: FAIL — module `../src/agent/sandbox.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/agent/sandbox.ts`:

```ts
import { spawnSync } from "node:child_process";
import type { NetworkMode } from "./networkPolicy.js";

/** A verified no-network wrapper for shell commands. Structural on purpose:
 * engine-layer tool contexts accept this shape without importing this module. */
export interface SandboxAdapter {
  readonly kind: "netns";
  wrap(command: string): { cmd: string; args: string[] };
}

export type SandboxProbeResult =
  | { available: true; adapter: SandboxAdapter }
  | { available: false; reason: string };

export type SandboxRunner =
  (cmd: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string };

export const PROBE_TIMEOUT_MS = 5000;

// Prints one "<name> <operstate>" line per interface. A fresh netns has only
// lo, and lo starts DOWN — exactly "lo down" is the pass condition.
const PROBE_SCRIPT =
  'for i in /sys/class/net/*; do printf "%s %s\\n" "${i##*/}" "$(cat "$i/operstate")"; done';

function defaultRunner(cmd: string, args: string[], timeoutMs: number): { status: number | null; stdout: string } {
  const res = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true });
  return { status: res.status, stdout: typeof res.stdout === "string" ? res.stdout : "" };
}

interface Candidate {
  bin: string;
  prefix: string[];
}

function candidates(): Candidate[] {
  return [
    { bin: "unshare", prefix: ["-n"] },
    { bin: "bwrap", prefix: ["--unshare-net", "--dev-bind", "/", "/"] }
  ];
}

export function probeSandbox(
  runner: SandboxRunner = defaultRunner,
  platform: string = process.platform
): SandboxProbeResult {
  if (platform === "win32") {
    return { available: false, reason: "no-network sandbox requires Linux network namespaces" };
  }
  let lastReason = "no sandbox mechanism found (tried unshare, bwrap)";
  for (const c of candidates()) {
    const args = [...c.prefix, "/bin/sh", "-c", PROBE_SCRIPT];
    const res = runner(c.bin, args, PROBE_TIMEOUT_MS);
    // status null covers ENOENT, spawn errors, and timeouts: unusable, try next.
    if (res.status !== 0) continue;
    if (res.stdout.trim() !== "lo down") {
      lastReason = `${c.bin} ran but network isolation is not effective`;
      continue;
    }
    return { available: true, adapter: makeAdapter(c.bin) };
  }
  return { available: false, reason: lastReason };
}

function makeAdapter(bin: string): SandboxAdapter {
  return {
    kind: "netns",
    wrap(command: string) {
      if (bin === "bwrap") {
        return { cmd: "bwrap", args: ["--unshare-net", "--dev-bind", "/", "/", "/bin/sh", "-c", command] };
      }
      return { cmd: "unshare", args: ["-n", "/bin/sh", "-c", command] };
    }
  };
}

let cache: SandboxProbeResult | undefined;

export function probeSandboxCached(): SandboxProbeResult {
  if (!cache) cache = probeSandbox();
  return cache;
}

export function resetSandboxCacheForTests(): void {
  cache = undefined;
}

/** True when the current mode plus the machine's verified sandbox state
 * allows contained Bash execution. Only offlineStrict ever contains Bash. */
export function sandboxEnablesBash(mode: NetworkMode): boolean {
  return mode === "offlineStrict" && probeSandboxCached().available;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sandbox.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(agent): netns sandbox probe with unshare/bwrap adapters"
```

---

### Task 2: Engine wiring — Bash and background shells route through the wrapper

**Files:**
- Modify: `src/engine/tools/types.ts` (ToolContext)
- Modify: `src/engine/loop.ts` (~line 30 EngineLoopOptions, ~line 446 tool ctx assembly)
- Modify: `src/engine/tools/bash.ts:7-12,37-44`
- Modify: `src/engine/tools/backgroundShells.ts` (add `CommandWrapper`, `sandboxedBgSpawner`)
- Test: extend `tests/engine-bash-tool.test.ts`, `tests/engine-bg-bash.test.ts`

**Interfaces:**
- Consumes: structural shape `{ wrap(command: string): { cmd: string; args: string[] } }` (matches Task 1's `SandboxAdapter`).
- Produces: `ToolContext.sandbox?: { wrap(command: string): { cmd: string; args: string[] } }`; `EngineLoopOptions.sandbox?` same shape; `backgroundShells.CommandWrapper` and `sandboxedBgSpawner(wrapper: CommandWrapper): BgSpawner`.

- [ ] **Step 1: Write the failing bash tool test**

Append inside `describe("bashTool", ...)` in `tests/engine-bash-tool.test.ts`:

```ts
it("wraps the spawned command when a sandbox is present", async () => {
  const seen: Array<{ cmd: string; args: string[] }> = {};
  const out = await bashTool.execute(
    { command: "echo wrapped-hello" },
    {
      cwd: process.cwd(),
      sandbox: {
        wrap(command: string) {
          // Use a binary name that cannot exist so we can prove the wrapped
          // argv is what executes, and that there is no unwrapped retry.
          seen.args = ["-c", command];
          return { cmd: "cc-nonexistent-sandbox-bin", args: ["-c", command] };
        }
      }
    }
  );
  expect(seen.args?.join(" ")).toContain("echo wrapped-hello");
  expect(out.isError).toBe(true);
}, 15000);

it("executes successfully inside a real netns sandbox on Linux", async () => {
  if (process.platform === "win32") return;
  const probe = spawnSync("unshare", ["-n", "true"]);
  if (probe.error) return; // no unshare on this machine; skip silently
  const out = await bashTool.execute(
    { command: "cat /sys/class/net/lo/operstate" },
    { cwd: process.cwd(), sandbox: { wrap: c => ({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", c] }) } }
  );
  expect(out.isError).toBeFalsy();
  expect(out.content).toContain("down");
}, 15000);
```

Add to imports at the top of the file:

```ts
import { spawnSync } from "node:child_process";
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/engine-bash-tool.test.ts`
Expected: FAIL — first test fails because `bashTool` ignores `ctx.sandbox` (command runs unwrapped and succeeds, `out.isError` falsy).

- [ ] **Step 3: Implement engine changes**

In `src/engine/tools/types.ts`, add to `ToolContext` (after `networkPolicy`):

```ts
  /** Verified no-network wrapper for child commands. Present only when a
   * sandbox adapter is active (offlineStrict + verified probe). Shell-spawning
   * tools MUST route their command through it when present. */
  sandbox?: { wrap(command: string): { cmd: string; args: string[] } };
```

In `src/engine/tools/bash.ts`, replace lines 37–38:

```ts
    const { cmd, args } = shellArgs(String(input.command ?? ""));
```

with:

```ts
    const command = String(input.command ?? "");
    const { cmd, args } = ctx.sandbox ? ctx.sandbox.wrap(command) : shellArgs(command);
```

(no other change — `execFile(cmd, args, ...)` already uses those names).

In `src/engine/loop.ts`: add to `EngineLoopOptions` (next to `bgShells`, ~line 31):

```ts
  /** Verified no-network wrapper passed through to tool contexts. */
  sandbox?: { wrap(command: string): { cmd: string; args: string[] } };
```

and in the tool-context assembly at ~line 446 add:

```ts
        sandbox: this.opts.sandbox,
```

In `src/engine/tools/backgroundShells.ts`, add after `realBgSpawner`:

```ts
/** Structural wrapper type matching agent/sandbox.ts SandboxAdapter. */
export interface CommandWrapper {
  wrap(command: string): { cmd: string; args: string[] };
}

/** Spawns background shells inside a verified no-network sandbox. */
export function sandboxedBgSpawner(wrapper: CommandWrapper): BgSpawner {
  return (command, cwd) => {
    const { cmd, args } = wrapper.wrap(command);
    const child = spawn(cmd, args, { cwd });
    return child as unknown as ChildLike;
  };
}
```

- [ ] **Step 4: Extend background-shell tests**

First make the spawn injectable in `src/engine/tools/backgroundShells.ts` so the test can capture the argv without spawning anything:

```ts
export function sandboxedBgSpawner(wrapper: CommandWrapper, spawnFn: typeof spawn = spawn): BgSpawner {
  return (command, cwd) => {
    const { cmd, args } = wrapper.wrap(command);
    const child = spawnFn(cmd, args, { cwd });
    return child as unknown as ChildLike;
  };
}
```

and add to `tests/engine-bg-bash.test.ts`:

```ts
it("sandboxedBgSpawner spawns the wrapped argv", () => {
  const seen: Array<{ cmd: string; args: string[] }> = [];
  const fakeChild = { stdout: null, stderr: null, kill: () => {} };
  const spawner = sandboxedBgSpawner(
    { wrap: c => ({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", c] }) },
    (cmd: string, args: readonly string[]) => {
      seen.push({ cmd, args: [...args] });
      return fakeChild as never;
    }
  );
  spawner("echo hi", "/tmp");
  expect(seen[0]).toEqual({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", "echo hi"] });
});
```

Import `sandboxedBgSpawner` from `../src/engine/tools/backgroundShells.js` at the top of the test file.

- [ ] **Step 5: Run affected tests**

Run: `npx vitest run tests/engine-bash-tool.test.ts tests/engine-bg-bash.test.ts`
Expected: PASS (the nonexistent-binary test proves fail-closed: error tool result, no unwrapped retry).

- [ ] **Step 6: Commit**

```bash
git add src/engine/tools/types.ts src/engine/loop.ts src/engine/tools/bash.ts src/engine/tools/backgroundShells.ts tests/engine-bash-tool.test.ts tests/engine-bg-bash.test.ts
git commit -m "feat(engine): route Bash and background shells through sandbox wrapper"
```

---

### Task 3: Session wiring — probe at start, gate availability

**Files:**
- Modify: `src/agent/session.ts` (options interface ~line 66, `start()` ~lines 119–146, EngineLoop opts ~line 166)
- Test: extend `tests/session-integration.test.ts`

**Interfaces:**
- Consumes: `probeSandboxCached`, `SandboxProbeResult`, `resetSandboxCacheForTests` from Task 1; `sandboxedBgSpawner`, `CommandWrapper` from Task 2.
- Produces: `AgentSessionOptions.sandboxProbe?: () => SandboxProbeResult` (replaces `verifiedNoNetworkSandbox?: boolean`). Sessions default to the cached real probe; tests inject a fake.

- [ ] **Step 1: Write the failing session test**

In `tests/session-integration.test.ts`, following the file's existing minimal-options helper for constructing `AgentSession` (reuse it; the snippets below assume a `makeSession(opts)` helper — adapt names to what the file actually uses):

```ts
it("keeps Bash disabled under offlineStrict when the probe finds no sandbox", () => {
  const session = makeSession({
    networkMode: "offlineStrict",
    sandboxProbe: () => ({ available: false, reason: "none" })
  });
  session.start();
  expect(session.tools).not.toContain("Bash");
});

it("enables Bash and wires the adapter under offlineStrict when verified", () => {
  const adapter = {
    kind: "netns" as const,
    wrap: (command: string) => ({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", command] })
  };
  const session = makeSession({
    networkMode: "offlineStrict",
    sandboxProbe: () => ({ available: true, adapter })
  });
  session.start();
  expect(session.tools).toContain("Bash");
});

it("does not wrap commands outside offlineStrict even when verified", () => {
  const adapter = {
    kind: "netns" as const,
    wrap: (command: string) => ({ cmd: "unshare", args: ["-n", "/bin/sh", "-c", command] })
  };
  const session = makeSession({
    networkMode: "providerOnly",
    sandboxProbe: () => ({ available: true, adapter })
  });
  session.start();
  expect(session.tools).toContain("Bash"); // providerOnly always had Bash
});
```

If the file constructs sessions inline rather than via a helper, mirror the option subset it uses (`providerName`, `provider`, `permissionMode`, `cwd`, `onMessage`, `onPermissionRequest`, `onSessionId`) plus the fields shown above.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/session-integration.test.ts`
Expected: FAIL — `sandboxProbe` is not a known option (TS) / Bash stays disabled despite a verified probe.

- [ ] **Step 3: Implement**

In `src/agent/session.ts`:

1. Update imports:

```ts
import { BackgroundShellManager, realBgSpawner, sandboxedBgSpawner } from "../engine/tools/backgroundShells.js";
import { probeSandboxCached, type SandboxProbeResult } from "./sandbox.js";
```

2. In `AgentSessionOptions`, replace:

```ts
  verifiedNoNetworkSandbox?: boolean;
```

with:

```ts
  /** Probe override for tests; defaults to the cached real machine probe. */
  sandboxProbe?: () => SandboxProbeResult;
```

3. In `start()`, replace line 124:

```ts
    const bash = bashNetworkStatus(networkPolicy.mode, this.opts.verifiedNoNetworkSandbox === true);
```

with:

```ts
    const probe = (this.opts.sandboxProbe ?? probeSandboxCached)();
    // Wrapping applies ONLY under offlineStrict: in providerOnly/unrestricted
    // children legitimately need the network and must not be confined.
    const sandbox = probe.available && networkPolicy.mode === "offlineStrict" ? probe.adapter : undefined;
    const bash = bashNetworkStatus(networkPolicy.mode, sandbox !== undefined);
```

4. Replace line 137:

```ts
    const bgShells = new BackgroundShellManager(realBgSpawner);
```

with:

```ts
    const bgShells = new BackgroundShellManager(sandbox ? sandboxedBgSpawner(sandbox) : realBgSpawner);
```

5. In the `new EngineLoop({...})` options object, add next to `bgShells:`:

```ts
      sandbox,
```

(`EngineLoop` accepts the structural shape from Task 2; `SandboxAdapter` satisfies it.)

- [ ] **Step 4: Run affected tests**

Run: `npx vitest run tests/session-integration.test.ts tests/engine-loop.test.ts tests/print-adapter.test.ts`
Expected: PASS. (No caller currently passes `verifiedNoNetworkSandbox`, confirmed by grep, so removing the option breaks nothing else; `npm run build` in Step 6 double-checks.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts tests/session-integration.test.ts
git commit -m "feat(agent): probe sandbox at session start to enable contained Bash"
```

---

### Task 4: Surface real sandbox status in config, doctor, and the TUI notice

**Files:**
- Modify: `src/commands/cli/config.ts:8-11`
- Modify: `src/commands/cli/doctor.ts:90-113`
- Modify: `src/ui/networkController.ts:13-43`
- Test: update `tests/cliConfig.test.ts`, `tests/cliDoctor.test.ts`, `tests/networkController.test.ts`

**Interfaces:**
- Consumes: `sandboxEnablesBash(mode)` from Task 1.
- Produces: optional explicit `verified` parameters so tests stay deterministic regardless of the host machine:
  - `configReport(dir?, override?, verified?: boolean)`
  - doctor opts gain `bashVerified?: boolean`
  - `NetworkController` constructor gains 4th arg `bashVerified?: boolean`

- [ ] **Step 1: Write failing/updating tests first**

In each of the three test files, find assertions about `Bash networking` / `Bash network containment` / `notice()` output and add one deterministic case each (keep all existing assertions, passing explicit values so they hold on any machine):

`tests/cliConfig.test.ts`:

```ts
it("shows contained Bash when offlineStrict and sandbox verified", () => {
  const report = configReport(undefined, "offlineStrict", true);
  expect(report).toContain("contained");
});
```

(Adjust the first argument to whatever the existing tests pass — many likely call `configReport()` or with a temp dir; match that convention.)

`tests/cliDoctor.test.ts`: add `bashVerified: true` to one invocation's opts and assert the detail says `contained`; keep another invocation without it and assert the existing wording still appears on Windows-style environments by passing `bashVerified: false`.

`tests/networkController.test.ts`:

```ts
it("notice reports contained when offlineStrict and verified", () => {
  const c = new NetworkController("offlineStrict", providersFixture, undefined, true);
  expect(c.notice()).toContain("contained");
});

it("notice reports disabled when offlineStrict and not verified", () => {
  const c = new NetworkController("offlineStrict", providersFixture, undefined, false);
  expect(c.notice()).toContain("disabled");
});
```

(Match the fixture variable names the file already uses.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cliConfig.test.ts tests/cliDoctor.test.ts tests/networkController.test.ts`
Expected: FAIL — signatures don't accept the new arguments yet (TS) / notice ignores verification.

- [ ] **Step 3: Implement**

`src/commands/cli/config.ts` — change signature and line 11:

```ts
import { bashNetworkStatus, type NetworkMode } from "../../agent/networkPolicy.js";
import { sandboxEnablesBash } from "../../agent/sandbox.js";

export function configReport(dir: string = configDir(), override?: NetworkMode, verified?: boolean): string {
  ...
  const bash = bashNetworkStatus(networkMode, verified ?? sandboxEnablesBash(networkMode));
```

`src/commands/cli/doctor.ts` — in the opts type add `bashVerified?: boolean;`, then replace line 99:

```ts
  const bash = bashNetworkStatus(mode, opts.bashVerified ?? sandboxEnablesBash(mode));
```

with the corresponding import added at top:

```ts
import { sandboxEnablesBash } from "../../agent/sandbox.js";
```

Also enrich the "Bash network containment" check detail when unavailable under strict mode — change the detail line to:

```ts
      detail: mode === "offlineStrict" && !verified
        ? `${bash.description}; install unshare or bubblewrap to enable contained Bash`
        : `${bash.description}; policy does not claim to contain arbitrary LSP/stdio MCP child egress`,
```

`src/ui/networkController.ts`:

```ts
import { sandboxEnablesBash } from "../agent/sandbox.js";

  constructor(
    private current: NetworkMode,
    private providers: Record<string, ProviderConfig>,
    private recorder?: NetworkDecisionRecorder,
    private bashVerified?: boolean
  ) {}

  notice(): string {
    const bash = bashNetworkStatus(this.current, this.bashVerified ?? sandboxEnablesBash(this.current));
    return `Network mode: ${this.current}. Bash networking: ${bash.description}. ` +
      "Policy covers cloudcode-owned egress; LSP and stdio MCP child processes are governed by project trust.";
  }
```

Call sites (`nativeApp.ts:122`) keep three arguments — the fourth defaults and computes live.

- [ ] **Step 4: Run full suite and gates**

Run:
```powershell
npx vitest run tests/cliConfig.test.ts tests/cliDoctor.test.ts tests/networkController.test.ts
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cli/config.ts src/commands/cli/doctor.ts src/ui/networkController.ts tests/cliConfig.test.ts tests/cliDoctor.test.ts tests/networkController.test.ts
git commit -m "feat(ui): surface verified sandbox status in config, doctor, and notice"
```

---

## Manual verification (before closing)

On a Linux machine/container with util-linux present:

1. `cloudcode config` with `networkMode=offlineStrict` shows `Bash networking: contained`.
2. Interactive session: ask the model to run `curl https://example.com` via Bash — it fails with a DNS/connect error (no egress), while `ls` succeeds.
3. Background shell started via `run_in_background` is likewise confined (`KillShell` still works).
4. Switch `/config networkMode providerOnly` live: subsequent Bash commands are unwrapped and can reach the network.
5. On Windows: `cloudcode config` still reports `disabled`; behavior identical to before this change.
