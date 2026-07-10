# Permission Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember allow/deny permission decisions per directory (project-local), so repeated Read/Write/Edit prompts stop.

**Architecture:** A `PermissionStore` persists rules to `<cwd>/.cloudcode/permissions.json`. App consults it in `onPermissionRequest` before queueing a dialog (auto-resolve on hit), and writes rules when the upgraded 4-option `PermissionDialog` reports a "remember" decision. `/permissions list|clear` manages rules via two new `CommandContext` methods.

**Tech Stack:** Existing stack only (TypeScript ESM, Ink 5, vitest). No new dependencies.

## Global Constraints

- ALL code, comments, docs, identifiers in English only.
- ESM; relative imports end in `.js`; Node >= 18.
- Spec: `docs/superpowers/specs/2026-07-10-permission-memory-design.md`.
- Rules file: `<project cwd>/.cloudcode/permissions.json`, array of `{ tool, dir, decision }`.
- Deny rules take precedence over allow. Path match is normalized (forward slashes) and case-insensitive; a rule dir matches the dir itself and all subdirectories.
- Only requests with a string `file_path` input use memory; other tools keep plain Yes/No.
- Corrupt/missing rules file → empty rules; malformed entries skipped; store write failures surface as an error notice but the in-memory rule still applies.
- Existing tests must keep passing; existing chunk-safe input handling and permission flow must not regress.

---

### Task 1: PermissionStore

**Files:**
- Create: `src/agent/permissionStore.ts`
- Test: `tests/permissionStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type PermissionDecision = "allow" | "deny";
  interface PermissionRule { tool: string; dir: string; decision: PermissionDecision }
  class PermissionStore {
    constructor(cwd: string);                 // file: join(cwd, ".cloudcode", "permissions.json")
    check(tool: string, filePath: string): PermissionDecision | undefined;
    remember(tool: string, filePath: string, decision: PermissionDecision): void; // stores dirname(filePath); throws on persist failure AFTER applying in memory
    list(): PermissionRule[];
    clear(): void;
  }
  ```
- `dir` is stored normalized: absolute, forward slashes, lowercase. `check` matches `file === dir` prefix semantics: normalized file equals dir or starts with `dir + "/"`. Deny beats allow. `remember` replaces an existing rule with the same tool+dir.

- [ ] **Step 1: Write failing tests**

```ts
// tests/permissionStore.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionStore } from "../src/agent/permissionStore.js";

const tempCwd = () => mkdtempSync(join(tmpdir(), "cc-perm-"));

describe("PermissionStore", () => {
  it("remembers and checks a directory rule, including subdirectories", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "a.ts"), "allow");
    expect(store.check("Write", join(cwd, "src", "b.ts"))).toBe("allow");
    expect(store.check("Write", join(cwd, "src", "deep", "c.ts"))).toBe("allow");
    expect(store.check("Write", join(cwd, "other", "d.ts"))).toBeUndefined();
    expect(store.check("Read", join(cwd, "src", "b.ts"))).toBeUndefined(); // per-tool
  });

  it("does not match sibling directories sharing a prefix", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Read", join(cwd, "src", "a.ts"), "allow");
    expect(store.check("Read", join(cwd, "src2", "b.ts"))).toBeUndefined();
  });

  it("deny takes precedence over allow", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "sub", "a.ts"), "deny");
    store.remember("Write", join(cwd, "src", "sub", "b.ts"), "allow"); // same dir: replaced below anyway
    store.remember("Write", join(cwd, "src", "x.ts"), "allow");        // parent dir allow
    expect(store.check("Write", join(cwd, "src", "y.ts"))).toBe("allow");
  });

  it("replaces a rule with the same tool and dir (newest wins)", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "a.ts"), "deny");
    store.remember("Write", join(cwd, "src", "b.ts"), "allow");
    expect(store.list()).toHaveLength(1);
    expect(store.check("Write", join(cwd, "src", "c.ts"))).toBe("allow");
  });

  it("matches case-insensitively", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Read", join(cwd, "Src", "a.ts"), "allow");
    expect(store.check("Read", join(cwd, "src", "B.TS"))).toBe("allow");
  });

  it("persists across instances and clears", () => {
    const cwd = tempCwd();
    const a = new PermissionStore(cwd);
    a.remember("Read", join(cwd, "src", "a.ts"), "allow");
    const b = new PermissionStore(cwd);
    expect(b.check("Read", join(cwd, "src", "z.ts"))).toBe("allow");
    b.clear();
    const c = new PermissionStore(cwd);
    expect(c.list()).toEqual([]);
  });

  it("tolerates corrupt files and skips malformed entries", () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(cwd, ".cloudcode", "permissions.json"), "{nope");
    expect(new PermissionStore(cwd).list()).toEqual([]);
    writeFileSync(join(cwd, ".cloudcode", "permissions.json"),
      JSON.stringify([{ tool: "Read", dir: "/x", decision: "allow" }, { bad: true }, { tool: "Y", dir: 3, decision: "allow" }]));
    expect(new PermissionStore(cwd).list()).toHaveLength(1);
  });

  it("writes the rules file inside <cwd>/.cloudcode", () => {
    const cwd = tempCwd();
    new PermissionStore(cwd).remember("Write", join(cwd, "a.ts"), "allow");
    const raw = JSON.parse(readFileSync(join(cwd, ".cloudcode", "permissions.json"), "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].tool).toBe("Write");
    expect(raw[0].decision).toBe("allow");
  });
});
```

Run: `npx vitest run tests/permissionStore.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/agent/permissionStore.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  tool: string;
  dir: string;
  decision: PermissionDecision;
}

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

function isValidRule(r: unknown): r is PermissionRule {
  const rule = r as PermissionRule;
  return (
    !!rule &&
    typeof rule.tool === "string" &&
    typeof rule.dir === "string" &&
    (rule.decision === "allow" || rule.decision === "deny")
  );
}

export class PermissionStore {
  private rules: PermissionRule[] = [];
  private filePath: string;

  constructor(cwd: string) {
    this.filePath = join(cwd, ".cloudcode", "permissions.json");
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.rules = raw.filter(isValidRule);
    } catch {
      // missing or invalid file: start empty
    }
  }

  check(tool: string, filePath: string): PermissionDecision | undefined {
    const file = normalizePath(filePath);
    const matches = this.rules.filter(r => {
      if (r.tool !== tool) return false;
      const dir = normalizePath(r.dir);
      return file === dir || file.startsWith(dir + "/");
    });
    if (matches.some(r => r.decision === "deny")) return "deny";
    if (matches.some(r => r.decision === "allow")) return "allow";
    return undefined;
  }

  remember(tool: string, filePath: string, decision: PermissionDecision): void {
    const dir = normalizePath(dirname(resolve(filePath)));
    this.rules = this.rules.filter(r => !(r.tool === tool && normalizePath(r.dir) === dir));
    this.rules.push({ tool, dir, decision });
    // The in-memory rule applies even if persisting fails; the caller reports
    // the failure to the user.
    this.persist();
  }

  list(): PermissionRule[] {
    return [...this.rules];
  }

  clear(): void {
    this.rules = [];
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2));
  }
}
```

Run: `npx vitest run tests/permissionStore.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/permissionStore.ts tests/permissionStore.test.ts
git commit -m "feat: project-local permission rule store"
```

---

### Task 2: PermissionDialog four options

**Files:**
- Modify: `src/ui/PermissionDialog.tsx`
- Test: `tests/permissionDialog.test.tsx` (extend)

**Interfaces:**
- Consumes: existing `toolLabel` from `./transcript.js`.
- Produces: `PermissionDialog` props become:
  ```ts
  interface Props {
    request: { toolName: string; input: Record<string, unknown> };
    onDecision(allow: boolean, rememberAs?: "allow" | "deny"): void;
  }
  ```
  Behavior: when `request.input.file_path` is a string, four options — `Yes (y)`, `Always for this directory (a)`, `No (n)`, `Never for this directory (d)`; hotkeys y/a/n/d act immediately (`onDecision(true)`, `onDecision(true, "allow")`, `onDecision(false)`, `onDecision(false, "deny")`); arrow keys (all four) cycle the selection, Enter confirms the selected option, Esc = `onDecision(false)`. Without `file_path`, the existing two options and behavior are unchanged (arrows toggle, y/n/Esc/Enter as before).

- [ ] **Step 1: Write failing tests (append to tests/permissionDialog.test.tsx)**

```tsx
it("shows four options for file_path requests", async () => {
  const { lastFrame } = render(
    <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={() => {}} />
  );
  await wait();
  const frame = lastFrame()!;
  expect(frame).toContain("Yes (y)");
  expect(frame).toContain("Always for this directory (a)");
  expect(frame).toContain("No (n)");
  expect(frame).toContain("Never for this directory (d)");
});

it("hotkey 'a' resolves allow with remember", async () => {
  const onDecision = vi.fn();
  const { stdin } = render(
    <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
  );
  await wait();
  stdin.write("a");
  await wait();
  expect(onDecision).toHaveBeenCalledWith(true, "allow");
});

it("hotkey 'd' resolves deny with remember", async () => {
  const onDecision = vi.fn();
  const { stdin } = render(
    <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
  );
  await wait();
  stdin.write("d");
  await wait();
  expect(onDecision).toHaveBeenCalledWith(false, "deny");
});

it("arrow + Enter selects 'Always for this directory'", async () => {
  const onDecision = vi.fn();
  const { stdin } = render(
    <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
  );
  await wait();
  stdin.write("[C"); // right arrow -> option index 1
  await wait();
  stdin.write("\r");
  await wait();
  expect(onDecision).toHaveBeenCalledWith(true, "allow");
});

it("keeps two options for requests without file_path", async () => {
  const { lastFrame } = render(
    <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={() => {}} />
  );
  await wait();
  expect(lastFrame()).not.toContain("Always for this directory");
  expect(lastFrame()).toContain("Yes (y)");
  expect(lastFrame()).toContain("No (n)");
});
```

Note: the existing two-option tests assert `onDecision` called with `true` / `false`; `toHaveBeenCalledWith(true)` remains satisfied when the implementation calls `onDecision(true)` with one argument — do not weaken them. Arrow escape sequences must contain a real ESC byte (`[C`).

Run: `npx vitest run tests/permissionDialog.test.tsx` — Expected: new tests FAIL.

- [ ] **Step 2: Rewrite `src/ui/PermissionDialog.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { toolLabel } from "./transcript.js";

interface Props {
  request: { toolName: string; input: Record<string, unknown> };
  onDecision(allow: boolean, rememberAs?: "allow" | "deny"): void;
}

interface Option {
  label: string;
  hotkey: string;
  allow: boolean;
  rememberAs?: "allow" | "deny";
}

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

export function PermissionDialog({ request, onDecision }: Props) {
  const hasFilePath = typeof request.input.file_path === "string";
  const options = hasFilePath ? FILE_OPTIONS : BASE_OPTIONS;
  const [selected, setSelected] = useState(0);

  const decide = (opt: Option) => {
    if (opt.rememberAs) onDecision(opt.allow, opt.rememberAs);
    else onDecision(opt.allow);
  };

  useInput((input, key) => {
    const hot = options.find(o => o.hotkey === input.toLowerCase());
    if (hot) { decide(hot); return; }
    if (key.escape) { onDecision(false); return; }
    if (key.leftArrow || key.upArrow) {
      setSelected(s => (s + options.length - 1) % options.length);
    } else if (key.rightArrow || key.downArrow) {
      setSelected(s => (s + 1) % options.length);
    } else if (key.return) {
      decide(options[selected]);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Permission required</Text>
      <Text>{toolLabel(request.toolName, request.input)}</Text>
      <Box gap={2} flexWrap="wrap">
        {options.map((opt, i) => (
          <Text key={opt.hotkey} inverse={i === selected}> {opt.label} </Text>
        ))}
      </Box>
    </Box>
  );
}
```

Run: `npx vitest run tests/permissionDialog.test.tsx` — Expected: ALL pass (old two-option tests included; the old test wrote "y"/"n" and asserted single-arg calls, which still hold). Then `npx tsc --noEmit` — Expected: clean (App's existing `decidePermission(allow: boolean)` remains assignable to the widened callback).

- [ ] **Step 3: Commit**

```bash
git add src/ui/PermissionDialog.tsx tests/permissionDialog.test.tsx
git commit -m "feat: four-option permission dialog with remember choices"
```

---

### Task 3: /permissions list and clear

**Files:**
- Modify: `src/commands/types.ts`, `src/commands/builtins.ts`, `src/ui/App.tsx`
- Test: `tests/commands.test.ts` (extend)

**Interfaces:**
- Consumes: `PermissionStore` (Task 1).
- Produces:
  - `CommandContext` gains:
    ```ts
    listPermissionRules(): string;   // formatted rules or "No permission rules."
    clearPermissionRules(): void;
    ```
  - `/permissions list` → `ctx.notice(ctx.listPermissionRules())`.
  - `/permissions clear` → `ctx.clearPermissionRules()` then `ctx.notice("Cleared all permission rules for this project.")`.
  - `/permissions <mode>` unchanged; unknown args still notice `Valid modes: default, acceptEdits, bypassPermissions` (extend usage text to mention list/clear in the command description only).
  - App: `const permissionStoreRef = useRef(new PermissionStore(props.cwd));` and implements the two ctx methods:
    - `listPermissionRules`: rules mapped to lines `"${decision === "allow" ? "✓" : "✗"} ${tool} ${dir}"` joined with newline, or `"No permission rules."` when empty.
    - `clearPermissionRules`: `permissionStoreRef.current.clear()`.

- [ ] **Step 1: Write failing tests**

In `tests/commands.test.ts`, add to `mockCtx()`:

```ts
listPermissionRules: vi.fn().mockReturnValue("✓ Write /p/src"),
clearPermissionRules: vi.fn(),
```

Append tests:

```ts
describe("/permissions list and clear", () => {
  it("lists rules", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "list");
    expect(ctx.listPermissionRules).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("✓ Write /p/src");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
  });

  it("clears rules", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "clear");
    expect(ctx.clearPermissionRules).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Cleared all permission rules for this project.");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/commands.test.ts` — Expected: FAIL (type error on mockCtx / behavior missing).

- [ ] **Step 2: Implement**

`src/commands/types.ts` — add to `CommandContext`:

```ts
listPermissionRules(): string;
clearPermissionRules(): void;
```

`src/commands/builtins.ts` — in the `permissions` command, before the mode check:

```ts
if (args === "list") { ctx.notice(ctx.listPermissionRules()); return; }
if (args === "clear") { ctx.clearPermissionRules(); ctx.notice("Cleared all permission rules for this project."); return; }
```

and change its `description` to `"Permission mode or rules: /permissions <default|acceptEdits|bypassPermissions|list|clear>"`.

`src/ui/App.tsx` — add import and ref:

```tsx
import { PermissionStore } from "../agent/permissionStore.js";
// with the other refs:
const permissionStoreRef = useRef(new PermissionStore(props.cwd));
```

and add to the `ctx` object:

```tsx
listPermissionRules: () => {
  const rules = permissionStoreRef.current.list();
  if (rules.length === 0) return "No permission rules.";
  return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir}`).join("\n");
},
clearPermissionRules: () => permissionStoreRef.current.clear(),
```

Run: `npx vitest run` — Expected: ALL pass. `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/commands/types.ts src/commands/builtins.ts src/ui/App.tsx tests/commands.test.ts
git commit -m "feat: /permissions list and clear for permission rules"
```

---

### Task 4: App interception and remember wiring

**Files:**
- Modify: `src/ui/App.tsx`, `README.md`
- Test: `tests/app.test.tsx` (extend)

**Interfaces:**
- Consumes: `PermissionStore` ref (Task 3), 4-option dialog callback (Task 2).
- Produces (behavior):
  - `onPermissionRequest` (in `createSession`): if `req.input.file_path` is a string, `permissionStoreRef.current.check(req.toolName, filePath)`:
    - `"allow"` → `req.resolve(true)`, append notice `auto-allowed: <tool> <path> (rule)`, do NOT queue or change phase.
    - `"deny"` → `req.resolve(false)`, append notice `auto-denied: <tool> <path> (rule)`, do NOT queue.
    - `undefined` (or no file_path) → queue dialog as today.
  - `decidePermission(allow: boolean, rememberAs?: "allow" | "deny")`: when `rememberAs` is set and the active request has a string `file_path`, call `permissionStoreRef.current.remember(toolName, filePath, rememberAs)` in a try/catch — on error append an error item `Failed to save permission rule: <message>` (the in-memory rule still applies).
  - README gains a "Permission memory" paragraph.

- [ ] **Step 1: Write failing tests (append to tests/app.test.tsx)**

```tsx
function permissionProbeQueryFn(filePath: string, outcomes: unknown[]) {
  return (args: { prompt: AsyncIterable<unknown>; options: { canUseTool: (t: string, i: object) => Promise<unknown> } }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const _ of args.prompt) {
        outcomes.push(await args.options.canUseTool("Write", { file_path: filePath }));
        yield { type: "result", subtype: "success", total_cost_usd: 0, duration_ms: 1 };
      }
    })();
    return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
  };
}

it("auto-allows when a stored rule matches, without showing the dialog", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
  const { PermissionStore } = await import("../src/agent/permissionStore.js");
  new PermissionStore(cwd).remember("Write", join(cwd, "src", "seed.ts"), "allow");
  const outcomes: unknown[] = [];
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  const { stdin, lastFrame } = render(
    <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
         queryFn={permissionProbeQueryFn(join(cwd, "src", "file.ts"), outcomes) as never} />
  );
  await wait();
  stdin.write("go");
  await wait();
  stdin.write("\r");
  await wait(150);
  expect(outcomes[0]).toMatchObject({ behavior: "allow" });
  expect(lastFrame()).toContain("auto-allowed: Write");
  expect(lastFrame()).not.toContain("Permission required");
});

it("choosing 'Always' saves a rule so the next request auto-resolves", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
  const outcomes: unknown[] = [];
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  const { stdin, lastFrame } = render(
    <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
         queryFn={permissionProbeQueryFn(join(cwd, "src", "file.ts"), outcomes) as never} />
  );
  await wait();
  stdin.write("first");
  await wait();
  stdin.write("\r");
  await wait(150);
  expect(lastFrame()).toContain("Permission required");
  stdin.write("a"); // Always for this directory
  await wait(150);
  expect(outcomes[0]).toMatchObject({ behavior: "allow" });
  stdin.write("second");
  await wait();
  stdin.write("\r");
  await wait(150);
  expect(outcomes[1]).toMatchObject({ behavior: "allow" });
  expect(lastFrame()).toContain("auto-allowed: Write");
});

it("a deny rule auto-denies without a dialog", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
  const { PermissionStore } = await import("../src/agent/permissionStore.js");
  new PermissionStore(cwd).remember("Write", join(cwd, "secret", "seed.txt"), "deny");
  const outcomes: unknown[] = [];
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  const { stdin, lastFrame } = render(
    <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
         queryFn={permissionProbeQueryFn(join(cwd, "secret", "x.txt"), outcomes) as never} />
  );
  await wait();
  stdin.write("go");
  await wait();
  stdin.write("\r");
  await wait(150);
  expect(outcomes[0]).toMatchObject({ behavior: "deny" });
  expect(lastFrame()).toContain("auto-denied: Write");
  expect(lastFrame()).not.toContain("Permission required");
});
```

Run: `npx vitest run tests/app.test.tsx` — Expected: new tests FAIL.

- [ ] **Step 2: Implement in `src/ui/App.tsx`**

Replace the `onPermissionRequest` callback inside `createSession` with:

```tsx
onPermissionRequest: req => {
  const filePath = typeof req.input.file_path === "string" ? req.input.file_path : undefined;
  if (filePath) {
    const decision = permissionStoreRef.current.check(req.toolName, filePath);
    if (decision) {
      req.resolve(decision === "allow");
      setItems(prev => [...prev, {
        kind: "notice",
        text: `auto-${decision === "allow" ? "allowed" : "denied"}: ${req.toolName} ${filePath} (rule)`
      }]);
      return;
    }
  }
  setPermissionQueue(q => [...q, req]);
  setPhase("permission");
},
```

Replace `decidePermission` with:

```tsx
function decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
  if (rememberAs && activePermission && typeof activePermission.input.file_path === "string") {
    try {
      permissionStoreRef.current.remember(activePermission.toolName, activePermission.input.file_path, rememberAs);
    } catch (err) {
      setItems(prev => [...prev, {
        kind: "error",
        text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}`
      }]);
    }
  }
  activePermission?.resolve(allow);
  setPermissionQueue(q => {
    const rest = q.slice(1);
    if (rest.length === 0) setPhase("streaming");
    return rest;
  });
}
```

(`decidePermission` is passed to `<PermissionDialog onDecision={decidePermission} />` — signature now matches the widened callback.)

Run: `npx vitest run` — Expected: ALL pass. `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Update README.md**

Add after the UX section:

```markdown
## Permission memory

In the permission dialog for file tools (Read/Write/Edit), choose
"Always for this directory" or "Never for this directory" to remember the decision
for the file's directory and all subdirectories. Rules are stored per project in
`.cloudcode/permissions.json` (add `.cloudcode/` to your `.gitignore` if you don't
want them version-controlled). Deny rules beat allow rules. Manage them with
`/permissions list` and `/permissions clear`.
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx README.md tests/app.test.tsx
git commit -m "feat: auto-resolve permissions from remembered directory rules"
```
