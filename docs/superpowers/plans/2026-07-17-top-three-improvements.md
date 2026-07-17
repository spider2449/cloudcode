# Top-Three Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the skills test isolation leak, thread the abort signal into tool execution so Esc actually interrupts running tools, and add command-prefix permission rules for the Bash tool.

**Architecture:** Three independent tasks against the existing engine/agent/ui layering. Task 1 is test-only. Task 2 extends `ToolContext` with an optional `AbortSignal` flowing from `EngineLoop.runTurn` into tool `execute()`. Task 3 extends `PermissionStore` with a second rule shape (`prefix` instead of `dir`), consults it in `decidePermission`, and adds "Always/Never for this command" options to both permission UIs.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node >= 18, vitest.

## Global Constraints

- All code comments must be in English (user's global standard).
- Imports between `src` files use the `.js` suffix (e.g. `from "./types.js"`), matching the existing ESM style.
- Run tests with `npx vitest run <file>`; the full suite has known pre-existing failures only in `tests/skills.test.ts` (fixed by Task 1) and a flaky provider test in `tests/app.test.tsx` — do not chase the latter.
- Commit after each task with a conventional-commit message ending in the Claude co-author trailer.

---

### Task 1: Skills test isolation fix

`loadSkills(cwd, userDir, reposDir)` defaults `reposDir` to `~/.cloudcode/skill-repos`. Eight tests in `tests/skills.test.ts` pass `userDir` but not `reposDir`, so real installed skill repos (e.g. obra--superpowers) leak into assertions and the tests fail on any machine with repos installed.

**Files:**
- Modify: `tests/skills.test.ts` (test-only change; no src changes)

**Interfaces:**
- Consumes: `loadSkills(cwd: string, userDir?: string, reposDir?: string): Skill[]` from `src/agent/skills.ts:101`
- Produces: nothing (test hygiene)

- [ ] **Step 1: Confirm the current failures**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — several `loadSkills` tests report extra skills whose `source` starts with `repo:` (only on machines with skill repos installed, which includes this one).

- [ ] **Step 2: Add an isolated reposDir helper and thread it through every `loadSkills` call in the `loadSkills` describe block**

In `tests/skills.test.ts`, every `loadSkills(...)` call inside the `describe("loadSkills", ...)` block (lines 28, 40, 49, 53, 62, 71, 78, 91) must gain a third argument pointing at a directory that does not exist inside the temp root. Example for the first test — apply the same pattern to all eight:

```ts
// before
const skills = loadSkills(cwd, join(root, "nouser"));
// after
const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
```

And the parameterless-cwd test:

```ts
// before
expect(loadSkills(join(root, "nope"), join(root, "nouser"))).toEqual([]);
// after
expect(loadSkills(join(root, "nope"), join(root, "nouser"), join(root, "no-repos"))).toEqual([]);
```

The `describe("repo skills", ...)` tests already pass `reposDir` explicitly — leave them alone.

- [ ] **Step 3: Run the file to verify it passes**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS, all tests.

- [ ] **Step 4: Commit**

```bash
git add tests/skills.test.ts
git commit -m "test: isolate skills tests from installed skill repos

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Thread AbortSignal into tool execution

Esc aborts the API stream (`EngineLoop.runTurn` receives a signal) but `runTool` never passes it to `tool.execute`, so a running Bash command finishes its full duration before the turn ends, and subsequent queued tool calls in the same batch still run after abort.

**Files:**
- Modify: `src/engine/tools/types.ts` (add `signal` to `ToolContext`)
- Modify: `src/engine/loop.ts:116-123` (pass signal into `runTool`; short-circuit remaining tools after abort)
- Modify: `src/engine/tools/bash.ts` (honor the signal in `execFile`; distinguish interrupt from timeout)
- Test: `tests/engine-loop.test.ts`, `tests/engine-bash-tool.test.ts`

**Interfaces:**
- Consumes: `ToolContext { cwd: string }` (`src/engine/tools/types.ts:1`), `EngineLoop.runTurn(userText, signal)` (`src/engine/loop.ts:86`)
- Produces: `ToolContext { cwd: string; signal?: AbortSignal }` — every `ToolDef.execute` may now receive `ctx.signal`. `runTool(block, signal)` new second parameter. API invariant preserved: every `tool_use` block still gets a matching `tool_result` in the next user message even when skipped due to abort (content `"Interrupted by user"`, `is_error: true`).

- [ ] **Step 1: Write the failing loop test**

Append to `tests/engine-loop.test.ts` (reuse the file's existing fake-client helpers; the test below shows the shape assuming a helper that yields a tool_use turn — adapt the event fixture to the file's existing pattern for tool_use streams):

```ts
it("passes the abort signal to tools and skips remaining tools after abort", async () => {
  const controller = new AbortController();
  const seenSignals: Array<AbortSignal | undefined> = [];
  const ran: string[] = [];
  const tools = [
    {
      name: "SlowTool",
      description: "",
      input_schema: { type: "object" },
      async execute(_input: Record<string, unknown>, ctx: { cwd: string; signal?: AbortSignal }) {
        seenSignals.push(ctx.signal);
        ran.push("SlowTool");
        controller.abort(); // simulate Esc while the tool is running
        return { content: "done" };
      }
    },
    {
      name: "SecondTool",
      description: "",
      input_schema: { type: "object" },
      async execute() {
        ran.push("SecondTool");
        return { content: "should not run" };
      }
    }
  ];
  // Fake client: first response requests both tools, then the aborted
  // follow-up request throws (matching real SDK behavior on abort).
  const client = {
    async *create(_req: unknown, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "SlowTool" } };
      yield { type: "content_block_stop" };
      yield { type: "content_block_start", content_block: { type: "tool_use", id: "t2", name: "SecondTool" } };
      yield { type: "content_block_stop" };
      yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
    }
  };
  const messages: unknown[] = [];
  const loop = new EngineLoop({
    client,
    model: "m",
    systemPrompt: "s",
    tools,
    cwd: ".",
    permissionMode: "bypassPermissions",
    store: new PermissionStore(tmpCwd), // use the file's existing store fixture
    onMessage: m => messages.push(m),
    requestPermission: async () => true
  });
  await loop.runTurn("go", controller.signal);
  expect(seenSignals[0]).toBe(controller.signal);
  expect(ran).toEqual(["SlowTool"]); // SecondTool skipped after abort
  // Both tool_use ids still received tool_result entries (API invariant).
  const resultsMsg = loop.messages.find(
    m => (m as { role?: string; content?: unknown[] }).role === "user" && Array.isArray((m as { content?: unknown[] }).content)
  ) as { content: Array<{ tool_use_id: string; content: string }> };
  expect(resultsMsg.content.map(r => r.tool_use_id)).toEqual(["t1", "t2"]);
  expect(resultsMsg.content[1].content).toContain("Interrupted");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/engine-loop.test.ts -t "abort signal"`
Expected: FAIL — `seenSignals[0]` is `undefined` and `ran` includes `"SecondTool"`.

- [ ] **Step 3: Implement — types.ts**

```ts
export interface ToolContext {
  cwd: string;
  // Aborts when the user interrupts the turn; long-running tools should
  // honor it and stop early.
  signal?: AbortSignal;
}
```

- [ ] **Step 4: Implement — loop.ts**

In `runTurn`, replace the tool-execution loop (`src/engine/loop.ts:115-123`) with:

```ts
        const results = [];
        for (const block of turn.blocks) {
          this.opts.onMessage(assistantMessage([block]));
          if (block.type !== "tool_use") continue;
          // After an interrupt, still emit a tool_result for every remaining
          // tool_use id (the API requires one per id on resume), but do not
          // execute the tools.
          const result = signal.aborted
            ? { type: "tool_result", tool_use_id: block.id, content: "Interrupted by user", is_error: true }
            : await this.runTool(block, signal);
          results.push(result);
          this.opts.onMessage(toolResultMessage(result.tool_use_id, result.content, result.is_error === true));
        }
        this.messages.push({ role: "user", content: results });
        if (signal.aborted) break;
```

And change `runTool`'s signature and the `execute` call (`src/engine/loop.ts:224,239`):

```ts
  private async runTool(block: { id: string; name: string; input: Record<string, unknown> }, signal: AbortSignal) {
```

```ts
      const out = await tool.execute(block.input, { cwd: this.opts.cwd, signal });
```

- [ ] **Step 5: Run the loop test to verify it passes**

Run: `npx vitest run tests/engine-loop.test.ts`
Expected: PASS (all tests in the file — the existing ones must not regress).

- [ ] **Step 6: Write the failing bash-tool test**

Append to `tests/engine-bash-tool.test.ts`:

```ts
it("kills the command and reports an interrupt when the signal aborts", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = bashTool.execute(
    // A sleep long enough that only an abort can end it quickly.
    { command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30" },
    { cwd: process.cwd(), signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 200);
  const out = await pending;
  expect(Date.now() - started).toBeLessThan(10000);
  expect(out.isError).toBe(true);
  expect(out.content).toContain("interrupted");
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/engine-bash-tool.test.ts -t "interrupt"`
Expected: FAIL — the promise only resolves after the 30s sleep finishes or the 2-minute default timeout (test times out or the message says "timed out").

- [ ] **Step 8: Implement — bash.ts**

Replace the `execute` body of `src/engine/tools/bash.ts` with:

```ts
  execute(input, ctx) {
    const { cmd, args } = shellArgs(String(input.command ?? ""));
    const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT;
    return new Promise(resolvePromise => {
      execFile(
        cmd,
        args,
        { cwd: ctx.cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal },
        (err, stdout, stderr) => {
          let content = [stdout, stderr].filter(Boolean).join("\n");
          if (content.length > MAX_OUTPUT) content = content.slice(0, MAX_OUTPUT) + "\n… (output truncated)";
          if (err) {
            const killed = (err as { killed?: boolean }).killed;
            const code = (err as { code?: number | string }).code;
            // An aborted signal also sets killed; check the signal first so
            // an interrupt is not misreported as a timeout.
            const reason = ctx.signal?.aborted
              ? "Command interrupted by user"
              : killed
                ? `Command timed out after ${timeout}ms`
                : `Command failed with exit code ${code ?? "unknown"}`;
            resolvePromise({ content: `${reason}\n${content}`.trim(), isError: true });
          } else {
            resolvePromise({ content: content || "(no output)" });
          }
        }
      );
    });
  }
```

- [ ] **Step 9: Run both test files to verify they pass**

Run: `npx vitest run tests/engine-bash-tool.test.ts tests/engine-loop.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/engine/tools/types.ts src/engine/loop.ts src/engine/tools/bash.ts tests/engine-loop.test.ts tests/engine-bash-tool.test.ts
git commit -m "feat(engine): thread abort signal into tool execution

Esc now kills a running Bash command and skips remaining queued tools,
while still emitting a tool_result per tool_use id so resumed history
stays valid for the API.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Command-prefix permission rules for Bash

Today `PermissionStore` only holds per-directory rules keyed on `file_path`, so Bash prompts on every call unless the user switches to `bypassPermissions`. Add prefix rules (`{ tool: "Bash", prefix: "git", decision }`): the permission dialog gains "Always/Never for '<first-word>' commands", `decidePermission` consults them, and `/permissions list` shows them.

**Files:**
- Modify: `src/agent/permissionStore.ts` (rule shape, `checkCommand`, `rememberCommand`, `commandPrefix` helper)
- Modify: `src/engine/permissions.ts` (consult command rules for Bash)
- Modify: `src/ui/widgets/overlay.ts:19-29,86-90` (native UI options)
- Modify: `src/ui/PermissionDialog.tsx:18-33` (Ink UI options)
- Modify: `src/ui/nativeApp.ts:271-283,368-372` (remember + list)
- Modify: `src/ui/App.tsx:458-462,387-391` (remember + list)
- Test: `tests/permissionStore.test.ts`, `tests/engine-permissions.test.ts`, `tests/permissionDialog.test.tsx`

**Interfaces:**
- Consumes: `PermissionStore.check(tool, filePath)`, `remember(tool, filePath, decision)`, `list()` (`src/agent/permissionStore.ts`); `decidePermission(toolName, input, mode, store)` (`src/engine/permissions.ts:10`)
- Produces:
  - `PermissionRule` becomes `{ tool: string; decision: "allow" | "deny"; dir?: string; prefix?: string }` with exactly one of `dir`/`prefix` set.
  - `commandPrefix(command: string): string` — first whitespace-delimited token of the trimmed command (exported from `permissionStore.ts`).
  - `PermissionStore.checkCommand(command: string): "allow" | "deny" | undefined` — matches Bash prefix rules; deny beats allow.
  - `PermissionStore.rememberCommand(prefix: string, decision: "allow" | "deny"): void`.

- [ ] **Step 1: Write the failing store tests**

Append to `tests/permissionStore.test.ts` (reuse the file's existing temp-cwd fixture; shown here as `cwd`):

```ts
describe("command prefix rules", () => {
  it("commandPrefix extracts the first token", () => {
    expect(commandPrefix("git status --short")).toBe("git");
    expect(commandPrefix("  npm  test ")).toBe("npm");
    expect(commandPrefix("")).toBe("");
  });

  it("rememberCommand + checkCommand allow a matching prefix", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("git", "allow");
    expect(store.checkCommand("git status")).toBe("allow");
    expect(store.checkCommand("git")).toBe("allow");
  });

  it("matches whole tokens only, not substrings", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("git", "allow");
    expect(store.checkCommand("github-cli auth")).toBeUndefined();
  });

  it("deny beats allow for the same command", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("rm", "allow");
    store.rememberCommand("rm", "deny");
    expect(store.checkCommand("rm -rf x")).toBe("deny");
  });

  it("persists prefix rules across instances", () => {
    new PermissionStore(cwd).rememberCommand("npm", "allow");
    expect(new PermissionStore(cwd).checkCommand("npm test")).toBe("allow");
    // Directory rules from the same file still work alongside prefix rules.
    const store = new PermissionStore(cwd);
    store.remember("Edit", join(cwd, "src", "a.ts"), "allow");
    expect(new PermissionStore(cwd).check("Edit", join(cwd, "src", "b.ts"))).toBe("allow");
  });
});
```

Add `commandPrefix` to the file's import from `../src/agent/permissionStore.js`, and `join` from `node:path` if not already imported.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/permissionStore.test.ts -t "command prefix"`
Expected: FAIL with "commandPrefix is not a function" / missing export.

- [ ] **Step 3: Implement the store changes**

In `src/agent/permissionStore.ts`, replace the `PermissionRule` interface and `isValidRule`, and add the new members:

```ts
export interface PermissionRule {
  tool: string;
  decision: PermissionDecision;
  // Exactly one of the following is set: `dir` for file-path rules,
  // `prefix` for Bash command rules (matched on the first token).
  dir?: string;
  prefix?: string;
}
```

```ts
function isValidRule(r: unknown): r is PermissionRule {
  const rule = r as PermissionRule;
  return (
    !!rule &&
    typeof rule.tool === "string" &&
    (rule.decision === "allow" || rule.decision === "deny") &&
    (typeof rule.dir === "string") !== (typeof rule.prefix === "string")
  );
}
```

```ts
// First whitespace-delimited token of a command, used as the remembered
// prefix (e.g. "git status --short" -> "git").
export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}
```

Update `check` to skip prefix rules (`if (r.dir === undefined) return false;` before `const dir = normalizePath(r.dir)` — with the optional field, narrow first):

```ts
  check(tool: string, filePath: string): PermissionDecision | undefined {
    const file = normalizePath(filePath);
    const matches = this.rules.filter(r => {
      if (r.tool !== tool || r.dir === undefined) return false;
      const dir = normalizePath(r.dir);
      return file === dir || file.startsWith(dir + "/");
    });
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }
```

Add the two new methods (after `remember`):

```ts
  // Prefix rules are case-insensitive: Windows shells treat command names
  // case-insensitively and the store already lowercases paths.
  checkCommand(command: string): PermissionDecision | undefined {
    const first = commandPrefix(command).toLowerCase();
    if (first === "") return undefined;
    const matches = this.rules.filter(
      r => r.tool === "Bash" && r.prefix !== undefined && r.prefix.toLowerCase() === first
    );
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }

  rememberCommand(prefix: string, decision: PermissionDecision): void {
    const p = prefix.toLowerCase();
    this.rules = this.rules.filter(r => !(r.tool === "Bash" && r.prefix?.toLowerCase() === p));
    this.rules.push({ tool: "Bash", prefix: p, decision });
    this.persist();
  }
```

- [ ] **Step 4: Run store tests to verify they pass**

Run: `npx vitest run tests/permissionStore.test.ts`
Expected: PASS (new and pre-existing tests).

- [ ] **Step 5: Write the failing decidePermission tests**

Append to `tests/engine-permissions.test.ts` (reuse its store fixture):

```ts
describe("Bash command rules", () => {
  it("allows a Bash command matching a remembered allow prefix", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: "git status" }, "default", store)).toBe("allow");
  });

  it("denies a Bash command matching a deny prefix even in acceptEdits", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "acceptEdits", store)).toBe("deny");
  });

  it("still asks for Bash commands with no matching rule", () => {
    expect(decidePermission("Bash", { command: "git status" }, "default", new PermissionStore(cwd))).toBe("ask");
  });

  it("bypassPermissions still allows everything", () => {
    const store = new PermissionStore(cwd);
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", store)).toBe("allow");
  });
});
```

Note the last test pins existing behavior: `bypassPermissions` short-circuits before rules, matching the file-rule behavior today.

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/engine-permissions.test.ts -t "Bash command"`
Expected: FAIL — the allow/deny cases return "ask".

- [ ] **Step 7: Implement decidePermission**

In `src/engine/permissions.ts`, after the `FILE_TOOLS` block (line 22) and before the `READ_ONLY` check, add:

```ts
  // Remembered command-prefix rules apply to Bash (deny beats allow).
  if (toolName === "Bash" && typeof input.command === "string") {
    const ruling = store.checkCommand(input.command);
    if (ruling === "deny") return "deny";
    if (ruling === "allow") return "allow";
  }
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing Ink dialog test**

Append to `tests/permissionDialog.test.tsx` (follow the file's existing render helper pattern with `ink-testing-library`):

```tsx
it("offers Always/Never options for Bash commands", () => {
  const { lastFrame } = render(
    <ThemeProvider>
      <PermissionDialog
        request={{ toolName: "Bash", input: { command: "git status" } }}
        onDecision={() => {}}
      />
    </ThemeProvider>
  );
  expect(lastFrame()).toContain("Always allow 'git' commands (a)");
  expect(lastFrame()).toContain("Never allow 'git' commands (d)");
});
```

(If the file renders without a `ThemeProvider` wrapper, match its existing pattern instead.)

- [ ] **Step 10: Run to verify failure**

Run: `npx vitest run tests/permissionDialog.test.tsx -t "Bash commands"`
Expected: FAIL — only "Yes (y)" / "No (n)" are rendered.

- [ ] **Step 11: Implement both permission UIs**

`src/ui/PermissionDialog.tsx` — replace the static option selection (lines 18-33) with:

```tsx
const BASE_OPTIONS: Option[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "No (n)", hotkey: "n", allow: false }
];

const FILE_OPTIONS: Option[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

function commandOptions(prefix: string): Option[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow '${prefix}' commands (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow '${prefix}' commands (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}
```

and inside the component:

```tsx
  const hasFilePath = typeof request.input.file_path === "string";
  const isBashCommand = request.toolName === "Bash" && typeof request.input.command === "string";
  const options = hasFilePath
    ? FILE_OPTIONS
    : isBashCommand
      ? commandOptions(commandPrefix(String(request.input.command)))
      : BASE_OPTIONS;
```

Import: `import { commandPrefix } from "../agent/permissionStore.js";`

`src/ui/widgets/overlay.ts` — add the same `commandOptions` factory next to `FILE_OPTIONS` (lines 19-29, same labels/hotkeys as above, plain array of `PermOption`), import `commandPrefix` from `"../../agent/permissionStore.js"`, and change `openPermission` (line 86):

```ts
  openPermission(request: PermissionRequest, onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void): void {
    this._mode = "permission";
    const hasFilePath = typeof request.input.file_path === "string";
    const isBashCommand = request.toolName === "Bash" && typeof request.input.command === "string";
    const options = hasFilePath
      ? FILE_OPTIONS
      : isBashCommand
        ? commandOptions(commandPrefix(String(request.input.command)))
        : BASE_OPTIONS;
    this.permissionState = { request, options, selected: 0, onDecision };
  }
```

- [ ] **Step 12: Wire "remember" and rule listing in both apps**

`src/ui/nativeApp.ts:271-283` — replace the body of `decidePermission` with:

```ts
  private decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
    const active = this.permissionQueue[0];
    if (rememberAs && active) {
      try {
        if (typeof active.input.file_path === "string") {
          this.permissionStore.remember(active.toolName, active.input.file_path, rememberAs);
        } else if (active.toolName === "Bash" && typeof active.input.command === "string") {
          this.permissionStore.rememberCommand(commandPrefix(String(active.input.command)), rememberAs);
        }
      } catch (err) {
        this.buffer.append({ kind: "error", text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    active?.resolve(allow);
    this.permissionQueue = this.permissionQueue.slice(1);
    if (this.permissionQueue.length === 0) this.phase = "streaming";
  }
```

(Keep the existing `active?.resolve(allow)` placement if it differs — read the current body first and only add the `rememberCommand` branch; the try/catch and queue handling must stay as they are today.)

Import `commandPrefix` in `nativeApp.ts` from `"../agent/permissionStore.js"`.

`src/ui/App.tsx:458-462` — same addition in its `decidePermission`: after the `file_path` branch, add:

```ts
    } else if (rememberAs && activePermission && activePermission.toolName === "Bash" && typeof activePermission.input.command === "string") {
      try {
        permissionStoreRef.current.rememberCommand(commandPrefix(String(activePermission.input.command)), rememberAs);
      } catch (err) {
        // Match the file-path branch's error reporting in this file.
      }
    }
```

(Mirror the exact error-reporting statement used by the existing `file_path` branch at `App.tsx:459-462` — read it and reuse the same notice mechanism rather than the comment above.)

Rule listing — in both `src/ui/nativeApp.ts:371` and `src/ui/App.tsx:390`, change the formatter:

```ts
return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir ?? `'${r.prefix}' commands`}`).join("\n");
```

- [ ] **Step 13: Run the dialog test and the app/overlay suites**

Run: `npx vitest run tests/permissionDialog.test.tsx tests/overlay.test.ts tests/app.test.ts tests/app.test.tsx`
Expected: PASS, except the known pre-existing flaky provider test in `app.test.tsx` ("switches provider via /provider...") — anything else failing is a regression from this task.

- [ ] **Step 14: Full suite + build**

Run: `npm run build && npx vitest run`
Expected: build clean; test failures limited to the known `app.test.tsx` provider flake (Task 1 already fixed `skills.test.ts`).

- [ ] **Step 15: Commit**

```bash
git add src/agent/permissionStore.ts src/engine/permissions.ts src/ui/PermissionDialog.tsx src/ui/widgets/overlay.ts src/ui/nativeApp.ts src/ui/App.tsx tests/permissionStore.test.ts tests/engine-permissions.test.ts tests/permissionDialog.test.tsx
git commit -m "feat(permissions): command-prefix rules for Bash

'Always/Never allow <cmd> commands' options in the permission dialog
persist per-project prefix rules, consulted by decidePermission with
deny beating allow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
