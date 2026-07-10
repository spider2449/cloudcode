# Richer Built-in Status Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the bottom status bar to show git branch/dirty flag, token usage with context %, session cost, and elapsed session time.

**Architecture:** App.tsx owns all state (existing pattern); `StatusBar` stays a pure presentational component; a new `useGitStatus` hook encapsulates async git polling with an injectable exec function for tests.

**Tech Stack:** TypeScript, React 18, Ink 5, vitest + ink-testing-library, node `child_process`.

## Global Constraints

- All code, comments, and identifiers in English only.
- ESM imports with `.js` extensions (matches existing codebase).
- Run tests with `npx vitest run <file>` from the repo root `F:\coding\rustPrj\cloudcode`.
- Spec: `docs/superpowers/specs/2026-07-10-statusline-design.md`.

---

### Task 1: StatusBar rendering with new segments

**Files:**
- Modify: `src/ui/StatusBar.tsx`
- Test: `tests/statusBar.test.tsx` (new)

**Interfaces:**
- Produces: `StatusBar` props
  ```ts
  interface Props {
    provider: string; model?: string; mode: string; cwd: string;
    costUsd?: number;
    gitBranch?: string; gitDirty?: boolean;
    tokens?: number; contextPct?: number;
    elapsedMs?: number;
  }
  ```
  Also exports `formatTokens(n: number): string` and `formatElapsed(ms: number): string` for testing.

- [ ] **Step 1: Write the failing test**

Create `tests/statusBar.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StatusBar, formatTokens, formatElapsed } from "../src/ui/StatusBar.js";

describe("formatTokens", () => {
  it("formats small counts plainly", () => expect(formatTokens(950)).toBe("950 tok"));
  it("formats thousands with one decimal", () => expect(formatTokens(12345)).toBe("12.3k tok"));
});

describe("formatElapsed", () => {
  it("formats minutes and seconds", () => expect(formatElapsed(252000)).toBe("4m 12s"));
  it("formats hours when >= 1h", () => expect(formatElapsed(3723000)).toBe("1h 2m 3s"));
  it("formats seconds only under a minute", () => expect(formatElapsed(9000)).toBe("9s"));
});

describe("StatusBar", () => {
  it("renders all segments", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" model="claude-sonnet-5" mode="default" cwd="/repo"
        costUsd={0.0123} gitBranch="master" gitDirty tokens={12345} contextPct={6} elapsedMs={252000} />
    );
    const f = lastFrame()!;
    expect(f).toContain("anthropic/claude-sonnet-5");
    expect(f).toContain("⎇ master*");
    expect(f).toContain("12.3k tok (6%)");
    expect(f).toContain("$0.0123");
    expect(f).toContain("4m 12s");
    expect(f).toContain("/repo");
  });

  it("omits unavailable segments", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" mode="default" cwd="/repo" />
    );
    const f = lastFrame()!;
    expect(f).not.toContain("⎇");
    expect(f).not.toContain("tok");
    expect(f).not.toContain("$");
    expect(f).toContain("anthropic · default · /repo");
  });

  it("shows tokens without percent when contextPct missing", () => {
    const { lastFrame } = render(
      <StatusBar provider="p" mode="default" cwd="/r" tokens={500} />
    );
    expect(lastFrame()).toContain("500 tok");
    expect(lastFrame()).not.toContain("%");
  });

  it("shows clean branch without asterisk", () => {
    const { lastFrame } = render(
      <StatusBar provider="p" mode="default" cwd="/r" gitBranch="dev" />
    );
    expect(lastFrame()).toContain("⎇ dev");
    expect(lastFrame()).not.toContain("dev*");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statusBar.test.tsx`
Expected: FAIL — `formatTokens` is not exported.

- [ ] **Step 3: Implement**

Replace `src/ui/StatusBar.tsx` with:

```tsx
import React from "react";
import { Text } from "ink";

interface Props {
  provider: string;
  model?: string;
  mode: string;
  cwd: string;
  costUsd?: number;
  gitBranch?: string;
  gitDirty?: boolean;
  tokens?: number;
  contextPct?: number;
  elapsedMs?: number;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatusBar({ provider, model, mode, cwd, costUsd, gitBranch, gitDirty, tokens, contextPct, elapsedMs }: Props) {
  const segments: string[] = [];
  segments.push(provider + (model ? `/${model}` : ""));
  segments.push(mode);
  if (gitBranch) segments.push(`⎇ ${gitBranch}${gitDirty ? "*" : ""}`);
  if (tokens != null && tokens > 0) {
    segments.push(formatTokens(tokens) + (contextPct != null ? ` (${contextPct}%)` : ""));
  }
  if (costUsd && costUsd > 0) segments.push(`$${costUsd.toFixed(4)}`);
  if (elapsedMs != null && elapsedMs > 0) segments.push(formatElapsed(elapsedMs));
  segments.push(cwd);
  return (
    <Text color="gray" dimColor>
      {segments.join(" · ")}
    </Text>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/statusBar.test.tsx tests/app.test.tsx`
Expected: PASS (app.test.tsx confirms no regression — existing props unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/ui/StatusBar.tsx tests/statusBar.test.tsx
git commit -m "feat: status bar segments for git, tokens, elapsed time"
```

---

### Task 2: useGitStatus hook

**Files:**
- Create: `src/ui/useGitStatus.ts`
- Test: `tests/useGitStatus.test.tsx` (new)

**Interfaces:**
- Produces:
  ```ts
  type GitExec = (args: string[], cwd: string) => Promise<string>; // resolves stdout, rejects on failure
  interface GitStatus { branch?: string; dirty: boolean }
  function useGitStatus(cwd: string, refreshKey: number, exec?: GitExec): GitStatus;
  ```
  Default `exec` uses `child_process.execFile("git", args, { cwd })`. Polls every 5000ms and re-runs when `refreshKey` changes. On any error returns `{ dirty: false }` with no branch.

- [ ] **Step 1: Write the failing test**

Create `tests/useGitStatus.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useGitStatus, type GitExec } from "../src/ui/useGitStatus.js";

function Probe({ exec, refreshKey = 0 }: { exec: GitExec; refreshKey?: number }) {
  const git = useGitStatus("/repo", refreshKey, exec);
  return <Text>{`branch=${git.branch ?? "none"} dirty=${git.dirty}`}</Text>;
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe("useGitStatus", () => {
  it("reports branch and dirty state", async () => {
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? "master\n" : " M src/file.ts\n";
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=master dirty=true");
  });

  it("reports clean tree", async () => {
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? "dev\n" : "";
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=dev dirty=false");
  });

  it("hides branch on git failure", async () => {
    const exec: GitExec = async () => { throw new Error("not a repo"); };
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=none dirty=false");
  });

  it("refreshes when refreshKey changes", async () => {
    let branch = "one";
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? `${branch}\n` : "";
    const { lastFrame, rerender } = render(<Probe exec={exec} refreshKey={0} />);
    await tick();
    branch = "two";
    rerender(<Probe exec={exec} refreshKey={1} />);
    await tick();
    expect(lastFrame()).toContain("branch=two");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/useGitStatus.test.tsx`
Expected: FAIL — module `../src/ui/useGitStatus.js` not found.

- [ ] **Step 3: Implement**

Create `src/ui/useGitStatus.ts`:

```ts
import { useEffect, useState } from "react";
import { execFile } from "node:child_process";

export type GitExec = (args: string[], cwd: string) => Promise<string>;

export interface GitStatus {
  branch?: string;
  dirty: boolean;
}

const defaultExec: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const POLL_MS = 5000;

export function useGitStatus(cwd: string, refreshKey: number, exec: GitExec = defaultExec): GitStatus {
  const [status, setStatus] = useState<GitStatus>({ dirty: false });

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const branch = (await exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
        const porcelain = await exec(["status", "--porcelain", "-uno"], cwd);
        if (!cancelled) setStatus({ branch: branch || undefined, dirty: porcelain.trim().length > 0 });
      } catch {
        if (!cancelled) setStatus({ dirty: false });
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, refreshKey]);

  return status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/useGitStatus.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/useGitStatus.ts tests/useGitStatus.test.tsx
git commit -m "feat: useGitStatus hook for branch and dirty polling"
```

---

### Task 3: Wire usage, elapsed time, and git into App

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx` (extend)

**Interfaces:**
- Consumes: `StatusBar` props from Task 1; `useGitStatus(cwd, refreshKey)` from Task 2.
- Produces: nothing new; App-internal state only.

Background: `handleMessage` in `src/ui/App.tsx` (currently lines 72–92) already accumulates `total_cost_usd` from `result` messages. SDK result messages also carry `usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`. Context window default: `200_000` tokens.

- [ ] **Step 1: Write the failing test**

Look at `tests/app.test.tsx` to see how the existing tests drive the App with a fake `queryFn` and emit SDK messages. Following that established pattern, add a test that:

```tsx
// Inside the existing describe block of tests/app.test.tsx, reusing the
// file's existing helpers for rendering App with a fake queryFn:
it("shows token usage and context percent after a result message", async () => {
  // emit (via the file's existing fake-session mechanism) a result message:
  // { type: "result", total_cost_usd: 0.01, duration_ms: 5,
  //   usage: { input_tokens: 9000, cache_read_input_tokens: 3000,
  //            cache_creation_input_tokens: 0, output_tokens: 345 } }
  // then assert on the last frame:
  expect(lastFrame()).toContain("12.3k tok");   // 9000+3000+345 = 12345 cumulative
  expect(lastFrame()).toContain("(6%)");        // (9000+3000) / 200000 = 6%
  expect(lastFrame()).toContain("$0.0100");
});
```

The exact harness code must match the file's existing conventions (fake queryFn, async message emission, frame polling) — adapt the skeleton above to them rather than inventing a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx`
Expected: new test FAILS (no token segment rendered); existing tests still pass.

- [ ] **Step 3: Implement in App.tsx**

3a. Add import after line 20 (`WorkingIndicator` import):

```ts
import { useGitStatus } from "./useGitStatus.js";
```

3b. Add state near the other `useState` calls (after `const [cost, setCost] = useState(0);`):

```ts
const [tokens, setTokens] = useState(0);
const [contextPct, setContextPct] = useState<number | undefined>(undefined);
const [turnCount, setTurnCount] = useState(0);
const startedAtRef = useRef(Date.now());
const [elapsedMs, setElapsedMs] = useState(0);
const CONTEXT_WINDOW = 200_000;
```

3c. In `handleMessage`, inside the `if (t === "result")` block, after the cost accumulation:

```ts
const usage = (msg as { usage?: Record<string, number> }).usage;
if (usage) {
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  setTokens(prev => prev + input + output);
  setContextPct(Math.min(100, Math.round((input / CONTEXT_WINDOW) * 100)));
}
setTurnCount(prev => prev + 1);
```

3d. Add the ticker and git hook near the existing mount `useEffect`:

```ts
useEffect(() => {
  const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
  return () => clearInterval(timer);
}, []);

const git = useGitStatus(props.cwd, turnCount);
```

3e. Replace the `<StatusBar … />` line (currently line 284) with:

```tsx
<StatusBar
  provider={providerName} model={model} mode={mode} cwd={props.cwd} costUsd={cost}
  gitBranch={git.branch} gitDirty={git.dirty}
  tokens={tokens} contextPct={contextPct} elapsedMs={elapsedMs}
/>
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx tests/app.test.tsx
git commit -m "feat: wire token usage, elapsed time, and git status into status bar"
```

---

## Self-Review Notes

- Spec coverage: git branch+dirty (Task 2/3), tokens+context % (Task 1/3), cost (existing, formatting kept), elapsed (Task 1/3), segment omission and error handling (Task 1 tests, Task 2 error test). Cumulative tokens vs. latest-turn context % implemented exactly per spec (3c).
- No placeholders; Task 3 Step 1 intentionally defers harness details to the existing app.test.tsx conventions with explicit input data and assertions.
- Type consistency: `GitExec`/`GitStatus` names match between Task 2 and Task 3; StatusBar prop names match Task 1 and Task 3 usage.
