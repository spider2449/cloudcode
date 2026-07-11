# Native Agent Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@anthropic-ai/claude-agent-sdk` (which spawns a 248 MB claude.exe subprocess) with cloudcode's own agent engine talking directly to the Anthropic Messages API.

**Architecture:** New `src/engine/` module: a streaming agent loop on `@anthropic-ai/sdk`, six built-in tools, a permission gate reusing the existing store/dialog, JSONL sessions, skills/CLAUDE.md prompt injection, and MCP via `@modelcontextprotocol/sdk`. `AgentSession` keeps its public surface; the TUI changes only type imports.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), React/Ink TUI, vitest, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`.

## Global Constraints

- ALL code, comments, and names in English only.
- Node >= 18; ESM with `.js` suffixes on relative imports (`"module": "nodenext"`).
- Tests: vitest, files under `tests/*.test.ts`. `tests/skills.test.ts` has 7 pre-existing environment-dependent failures — ignore those, everything else must pass.
- Spec: `docs/superpowers/specs/2026-07-11-native-engine-design.md`.
- The app must build (`npm run build`) at the end of every task.
- Windows is the primary dev platform; shell commands in tools must use PowerShell on win32, `/bin/sh` elsewhere.

---

### Task 1: Engine message and tool types

**Files:**
- Create: `src/engine/messages.ts`
- Create: `src/engine/tools/types.ts`
- Test: `tests/engine-messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EngineMessage`, `ContentBlock`, `Usage` (messages.ts); `ToolDef`, `ToolContext`, `ToolOutput` (tools/types.ts). Every later task imports these.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-messages.test.ts
import { describe, it, expect } from "vitest";
import { textDelta, assistantMessage, errorResult } from "../src/engine/messages.js";

describe("engine message constructors", () => {
  it("builds a stream_event carrying a text delta", () => {
    expect(textDelta("hi")).toEqual({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }
    });
  });

  it("builds an assistant message from content blocks", () => {
    const blocks = [{ type: "text" as const, text: "hello" }];
    expect(assistantMessage(blocks)).toEqual({ type: "assistant", message: { content: blocks } });
  });

  it("builds an error result", () => {
    expect(errorResult("boom")).toEqual({ type: "result", subtype: "error_during_execution", result: "boom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-messages.test.ts`
Expected: FAIL — cannot resolve `../src/engine/messages.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/messages.ts
// Message shapes the TUI consumes. Mirrors the subset of the former
// claude-agent-sdk SDKMessage union that transcript.ts and App.tsx read.
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type EngineMessage =
  | { type: "system"; subtype: "init"; session_id: string; tools: string[] }
  | { type: "stream_event"; event: { type: "content_block_delta"; delta: { type: "text_delta"; text: string } } }
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "result"; subtype: "success"; total_cost_usd?: number; duration_ms: number; usage?: Usage }
  | { type: "result"; subtype: "error_during_execution"; result: string };

export function textDelta(text: string): EngineMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

export function assistantMessage(content: ContentBlock[]): EngineMessage {
  return { type: "assistant", message: { content } };
}

export function errorResult(result: string): EngineMessage {
  return { type: "result", subtype: "error_during_execution", result };
}
```

```ts
// src/engine/tools/types.ts
export interface ToolContext {
  cwd: string;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the tool's input, sent verbatim to the API.
  input_schema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-messages.test.ts` — Expected: PASS. Then `npm run build` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine tests/engine-messages.test.ts
git commit -m "feat(engine): message and tool type definitions"
```

---

### Task 2: File tools — Read, Write, Edit

**Files:**
- Create: `src/engine/tools/read.ts`, `src/engine/tools/write.ts`, `src/engine/tools/edit.ts`
- Test: `tests/engine-file-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolContext`, `ToolOutput` from `src/engine/tools/types.js` (Task 1).
- Produces: `readTool: ToolDef`, `writeTool: ToolDef`, `editTool: ToolDef`. Input schemas use `file_path`, plus `content` (Write), `old_string`/`new_string`/`replace_all` (Edit), `offset`/`limit` (Read) — same names the TUI's `toolLabel`/`diffLines` already expect.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-file-tools.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../src/engine/tools/read.js";
import { writeTool } from "../src/engine/tools/write.js";
import { editTool } from "../src/engine/tools/edit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cc-tools-")); });
const ctx = () => ({ cwd: dir });

describe("readTool", () => {
  it("returns numbered lines", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo");
    const out = await readTool.execute({ file_path: join(dir, "a.txt") }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("1\tone");
    expect(out.content).toContain("2\ttwo");
  });
  it("errors on missing file", async () => {
    const out = await readTool.execute({ file_path: join(dir, "nope.txt") }, ctx());
    expect(out.isError).toBe(true);
  });
});

describe("writeTool", () => {
  it("creates a file", async () => {
    const p = join(dir, "new.txt");
    const out = await writeTool.execute({ file_path: p, content: "hello" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, "utf8")).toBe("hello");
  });
});

describe("editTool", () => {
  it("replaces a unique string", async () => {
    const p = join(dir, "e.txt");
    writeFileSync(p, "foo bar foo");
    const out = await editTool.execute({ file_path: p, old_string: "bar", new_string: "baz" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, "utf8")).toBe("foo baz foo");
  });
  it("errors when old_string is not unique and replace_all is false", async () => {
    const p = join(dir, "e2.txt");
    writeFileSync(p, "foo foo");
    const out = await editTool.execute({ file_path: p, old_string: "foo", new_string: "x" }, ctx());
    expect(out.isError).toBe(true);
  });
  it("replaces all occurrences with replace_all", async () => {
    const p = join(dir, "e3.txt");
    writeFileSync(p, "foo foo");
    await editTool.execute({ file_path: p, old_string: "foo", new_string: "x", replace_all: true }, ctx());
    expect(readFileSync(p, "utf8")).toBe("x x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-file-tools.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/tools/read.ts
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

const MAX_LINES = 2000;

export const readTool: ToolDef = {
  name: "Read",
  description: "Read a file from the filesystem. Returns cat -n style numbered lines.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "1-based line to start from" },
      limit: { type: "number", description: "Max lines to read" }
    },
    required: ["file_path"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      return { content: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 1;
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : MAX_LINES;
    const lines = text.split("\n").slice(offset - 1, offset - 1 + limit);
    const numbered = lines.map((l, i) => `${offset + i}\t${l}`).join("\n");
    return { content: numbered || "(empty file)" };
  }
};
```

```ts
// src/engine/tools/write.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

export const writeTool: ToolDef = {
  name: "Write",
  description: "Write content to a file, creating parent directories and overwriting if it exists.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Full file content" }
    },
    required: ["file_path", "content"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(input.content ?? ""));
      return { content: `Wrote ${abs}` };
    } catch (err) {
      return { content: `Cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};
```

```ts
// src/engine/tools/edit.ts
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

export const editTool: ToolDef = {
  name: "Edit",
  description: "Replace old_string with new_string in a file. old_string must match exactly and be unique unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" }
    },
    required: ["file_path", "old_string", "new_string"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      return { content: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { content: `old_string not found in ${abs}`, isError: true };
    if (count > 1 && input.replace_all !== true) {
      return { content: `old_string occurs ${count} times in ${abs}; pass replace_all: true or make it unique`, isError: true };
    }
    const next = input.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    writeFileSync(abs, next);
    return { content: `Edited ${abs}` };
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-file-tools.test.ts` — Expected: PASS. Then `npm run build` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools tests/engine-file-tools.test.ts
git commit -m "feat(engine): Read, Write, Edit tools"
```

---

### Task 3: Bash tool

**Files:**
- Create: `src/engine/tools/bash.ts`
- Test: `tests/engine-bash-tool.test.ts`

**Interfaces:**
- Consumes: `ToolDef` from Task 1.
- Produces: `bashTool: ToolDef` with input `{ command: string, timeout?: number }`. Runs PowerShell on win32, `/bin/sh -c` elsewhere. Output = stdout + stderr, truncated to 30000 chars, default timeout 120000 ms.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-bash-tool.test.ts
import { describe, it, expect } from "vitest";
import { bashTool } from "../src/engine/tools/bash.js";

const ctx = { cwd: process.cwd() };

describe("bashTool", () => {
  it("captures stdout", async () => {
    const out = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("hello");
  });
  it("reports nonzero exit as error with output", async () => {
    const out = await bashTool.execute({ command: "exit 3" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("exit code 3");
  });
  it("times out long commands", async () => {
    const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
    const out = await bashTool.execute({ command: sleep, timeout: 500 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content.toLowerCase()).toContain("timed out");
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-bash-tool.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/tools/bash.ts
import { execFile } from "node:child_process";
import type { ToolDef } from "./types.js";

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 120000;

function shellArgs(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { cmd: "/bin/sh", args: ["-c", command] };
}

export const bashTool: ToolDef = {
  name: "Bash",
  description: "Run a shell command (PowerShell on Windows, sh elsewhere) and return its output.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" }
    },
    required: ["command"]
  },
  execute(input, ctx) {
    const { cmd, args } = shellArgs(String(input.command ?? ""));
    const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT;
    return new Promise(resolvePromise => {
      execFile(cmd, args, { cwd: ctx.cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        let content = [stdout, stderr].filter(Boolean).join("\n");
        if (content.length > MAX_OUTPUT) content = content.slice(0, MAX_OUTPUT) + "\n… (output truncated)";
        if (err) {
          const killed = (err as { killed?: boolean }).killed;
          const code = (err as { code?: number | string }).code;
          const reason = killed ? `Command timed out after ${timeout}ms` : `Command failed with exit code ${code ?? "unknown"}`;
          resolvePromise({ content: `${reason}\n${content}`.trim(), isError: true });
        } else {
          resolvePromise({ content: content || "(no output)" });
        }
      });
    });
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-bash-tool.test.ts` — Expected: PASS. Then `npm run build` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/bash.ts tests/engine-bash-tool.test.ts
git commit -m "feat(engine): Bash tool with timeout and truncation"
```

---

### Task 4: Glob and Grep tools

**Files:**
- Create: `src/engine/tools/glob.ts`, `src/engine/tools/grep.ts`
- Test: `tests/engine-search-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef` from Task 1.
- Produces: `globTool: ToolDef` (input `{ pattern, path? }`, returns matching file paths one per line) and `grepTool: ToolDef` (input `{ pattern, path?, glob? }`, returns `file:line:text` matches). Both skip `node_modules`, `dist`, and `.git`; pure JS, no external binaries.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-search-tools.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../src/engine/tools/glob.js";
import { grepTool } from "../src/engine/tools/grep.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-search-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const alpha = 1;\n");
  writeFileSync(join(dir, "src", "b.txt"), "no code here\n");
  writeFileSync(join(dir, "node_modules", "pkg", "c.ts"), "export const hidden = 1;\n");
});
const ctx = () => ({ cwd: dir });

describe("globTool", () => {
  it("matches by extension recursively and skips node_modules", async () => {
    const out = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(out.content).toContain("a.ts");
    expect(out.content).not.toContain("c.ts");
    expect(out.content).not.toContain("b.txt");
  });
});

describe("grepTool", () => {
  it("finds regex matches with file and line", async () => {
    const out = await grepTool.execute({ pattern: "alpha" }, ctx());
    expect(out.content).toContain("a.ts");
    expect(out.content).toContain(":1:");
    expect(out.content).not.toContain("hidden");
  });
  it("reports no matches without error", async () => {
    const out = await grepTool.execute({ pattern: "zzz_not_there" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("No matches");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-search-tools.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/tools/glob.ts
import { readdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

const SKIP = new Set(["node_modules", "dist", ".git"]);
const MAX_RESULTS = 500;

export function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(join(dir, e.name));
      } else {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

// Translate a glob pattern to a RegExp: ** = any path, * = any name segment chars.
export function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i++;
        if (norm[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]".includes(c)) {
      re += "\\" + c;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c;
    }
  }
  return new RegExp(`(^|/)${re}$`);
}

export const globTool: ToolDef = {
  name: "Glob",
  description: "Find files matching a glob pattern like **/*.ts. Skips node_modules, dist, .git.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search (default cwd)" }
    },
    required: ["pattern"]
  },
  async execute(input, ctx) {
    const base = typeof input.path === "string" && input.path !== ""
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd;
    const re = globToRegExp(String(input.pattern ?? ""));
    const hits = walk(base)
      .filter(f => re.test(relative(base, f).replace(/\\/g, "/")))
      .slice(0, MAX_RESULTS);
    return { content: hits.length > 0 ? hits.join("\n") : "No files matched." };
  }
};
```

```ts
// src/engine/tools/grep.ts
import { readFileSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { walk, globToRegExp } from "./glob.js";

const MAX_MATCHES = 250;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export const grepTool: ToolDef = {
  name: "Grep",
  description: "Search file contents with a JavaScript regular expression. Returns file:line:text matches.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory to search (default cwd)" },
      glob: { type: "string", description: "Filter files by glob pattern, e.g. *.ts" }
    },
    required: ["pattern"]
  },
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern ?? ""));
    } catch (err) {
      return { content: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const base = typeof input.path === "string" && input.path !== ""
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd;
    const fileFilter = typeof input.glob === "string" && input.glob !== "" ? globToRegExp(input.glob) : undefined;
    const matches: string[] = [];
    for (const f of walk(base)) {
      const rel = relative(base, f).replace(/\\/g, "/");
      if (fileFilter && !fileFilter.test(rel)) continue;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (text.length > MAX_FILE_SIZE || text.includes(" ")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}:${lines[i].trim()}`);
          if (matches.length >= MAX_MATCHES) {
            matches.push("… (results truncated)");
            return { content: matches.join("\n") };
          }
        }
      }
    }
    return { content: matches.length > 0 ? matches.join("\n") : "No matches found." };
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-search-tools.test.ts` — Expected: PASS. Then `npm run build` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/glob.ts src/engine/tools/grep.ts tests/engine-search-tools.test.ts
git commit -m "feat(engine): Glob and Grep tools"
```

---

### Task 5: Permission gate

**Files:**
- Create: `src/engine/permissions.ts`
- Test: `tests/engine-permissions.test.ts`
- Read for reference: `src/agent/permissionStore.ts` (existing per-directory rule store)

**Interfaces:**
- Consumes: `PermissionStore` from `src/agent/permissionStore.js` — it exposes `check(toolName: string, filePath: string): "allow" | "deny" | undefined` style lookups (read the file; adapt to its actual API, do not change it). `PermissionMode` from `src/agent/session.js`.
- Produces: `decidePermission(toolName: string, input: Record<string, unknown>, mode: PermissionMode, store: PermissionStore): "allow" | "deny" | "ask"`. The loop (Task 6) calls this; only `"ask"` triggers the interactive dialog.

- [ ] **Step 1: Read `src/agent/permissionStore.ts` fully and note its exact method names and semantics (deny beats allow). Adjust the code below to its real API before writing the test.**

- [ ] **Step 2: Write the failing test**

```ts
// tests/engine-permissions.test.ts
import { describe, it, expect } from "vitest";
import { decidePermission } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore(): PermissionStore {
  // Point the store at an empty temp project so no real rules leak in.
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-perm-")));
}

describe("decidePermission", () => {
  it("bypassPermissions allows everything", () => {
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", freshStore())).toBe("allow");
  });
  it("acceptEdits auto-allows file edit tools but asks for Bash", () => {
    const store = freshStore();
    expect(decidePermission("Edit", { file_path: "x" }, "acceptEdits", store)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "acceptEdits", store)).toBe("allow");
    expect(decidePermission("Bash", { command: "ls" }, "acceptEdits", store)).toBe("ask");
  });
  it("default mode allows read-only tools and asks for the rest", () => {
    const store = freshStore();
    expect(decidePermission("Read", { file_path: "x" }, "default", store)).toBe("allow");
    expect(decidePermission("Glob", { pattern: "*" }, "default", store)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x" }, "default", store)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "default", store)).toBe("ask");
  });
});
```

Note: if `PermissionStore`'s constructor differs (check the real file), fix the test's `freshStore` accordingly — do not modify `permissionStore.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/engine-permissions.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 4: Write minimal implementation**

```ts
// src/engine/permissions.ts
import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";

const READ_ONLY = new Set(["Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["Write", "Edit"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

export type PermissionDecision = "allow" | "deny" | "ask";

export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  store: PermissionStore
): PermissionDecision {
  if (mode === "bypassPermissions") return "allow";
  // Per-directory rules (deny beats allow) apply to file tools.
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === "string") {
    const ruling = store.check(toolName, input.file_path); // adapt to the store's real API
    if (ruling === "deny") return "deny";
    if (ruling === "allow") return "allow";
  }
  if (READ_ONLY.has(toolName)) return "allow";
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return "allow";
  return "ask";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine-permissions.test.ts` — Expected: PASS. Then `npm run build` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/permissions.ts tests/engine-permissions.test.ts
git commit -m "feat(engine): permission gate over modes and per-directory rules"
```

---

### Task 6: Agent loop with injectable transport

**Files:**
- Create: `src/engine/loop.ts`, `src/engine/api.ts`
- Test: `tests/engine-loop.test.ts`
- Run: `npm install @anthropic-ai/sdk` first (add to dependencies).

**Interfaces:**
- Consumes: Tasks 1–5 exports; `ProviderConfig` from `src/agent/providers.js`.
- Produces:

```ts
export interface EngineOptions {
  client: MessagesClient;            // from api.ts; fake in tests
  model: string;
  systemPrompt: string;
  tools: ToolDef[];
  cwd: string;
  permissionMode: PermissionMode;
  store: PermissionStore;
  onMessage(msg: EngineMessage): void;
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}
export class EngineLoop {
  messages: unknown[];                            // API-shaped message history
  runTurn(userText: string, signal: AbortSignal): Promise<void>;
  setModel(model: string): void;
  setPermissionMode(mode: PermissionMode): void;
}
```

`MessagesClient` is the minimal streaming interface: `create(req): AsyncIterable<StreamEvent>` where `StreamEvent` is the raw Anthropic SSE event union (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` with `stop_reason`, `message_stop`). `api.ts` adapts `new Anthropic({ apiKey, baseURL }).messages.create({ ...req, stream: true })` to it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-loop.test.ts
import { describe, it, expect } from "vitest";
import { EngineLoop } from "../src/engine/loop.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef } from "../src/engine/tools/types.js";

// Scripted fake: each call to create() yields the next scripted event array.
function fakeClient(turns: object[][]) {
  let call = 0;
  return {
    async *create() {
      const events = turns[call++] ?? [];
      for (const e of events) yield e as never;
    }
  };
}

const echoTool: ToolDef = {
  name: "EchoTool",
  description: "echoes",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute(input) {
    return { content: `echo:${JSON.stringify(input)}` };
  }
};

const textTurn = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

const toolUseTurn = () => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "EchoTool", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "message_stop" }
];

function makeLoop(turns: object[][], received: unknown[]) {
  return new EngineLoop({
    client: fakeClient(turns),
    model: "test-model",
    systemPrompt: "sys",
    tools: [echoTool],
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-"))),
    onMessage: m => received.push(m),
    requestPermission: async () => true
  });
}

describe("EngineLoop", () => {
  it("streams text and emits assistant + success result", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([textTurn("hello")], received);
    await loop.runTurn("hi", new AbortController().signal);
    const types = received.map(m => (m as { type: string }).type);
    expect(types).toContain("stream_event");
    expect(types).toContain("assistant");
    const result = received.find(m => (m as { type: string }).type === "result") as { subtype: string };
    expect(result.subtype).toBe("success");
  });

  it("executes a tool call and continues to the next API turn", async () => {
    const received: unknown[] = [];
    const loop = makeLoop([toolUseTurn(), textTurn("done")], received);
    await loop.runTurn("go", new AbortController().signal);
    const assistants = received.filter(m => (m as { type: string }).type === "assistant");
    expect(assistants.length).toBe(2); // tool_use turn + final text turn
    // History must contain the tool_result the second call consumed.
    const flat = JSON.stringify(loop.messages);
    expect(flat).toContain("tool_result");
    expect(flat).toContain("echo:{\"x\":1}");
  });

  it("denied permission produces an error tool_result and still continues", async () => {
    const received: unknown[] = [];
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("ok")]) as never,
      model: "m",
      systemPrompt: "s",
      tools: [echoTool],
      cwd: process.cwd(),
      permissionMode: "default",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop2-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => false
    });
    await loop.runTurn("go", new AbortController().signal);
    expect(JSON.stringify(loop.messages)).toContain("User denied");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-loop.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/api.ts
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../agent/providers.js";

export interface StreamRequest {
  model: string;
  system: string;
  messages: unknown[];
  tools: unknown[];
  max_tokens: number;
}

export interface MessagesClient {
  create(req: StreamRequest, signal: AbortSignal): AsyncIterable<Record<string, unknown>>;
}

export function makeClient(cfg: ProviderConfig): MessagesClient {
  const anthropic = new Anthropic({
    apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "none",
    baseURL: cfg.baseUrl
  });
  return {
    async *create(req, signal) {
      const stream = await anthropic.messages.create(
        { ...req, stream: true } as never,
        { signal }
      );
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) yield event;
    }
  };
}
```

```ts
// src/engine/loop.ts
import type { EngineMessage, ContentBlock, Usage } from "./messages.js";
import { textDelta, assistantMessage, errorResult } from "./messages.js";
import type { ToolDef } from "./tools/types.js";
import type { MessagesClient } from "./api.js";
import type { PermissionMode } from "../agent/session.js";
import type { PermissionStore } from "../agent/permissionStore.js";
import { decidePermission } from "./permissions.js";

const MAX_TOKENS = 8192;
const MAX_LOOP_TURNS = 100;

export interface EngineOptions {
  client: MessagesClient;
  model: string;
  systemPrompt: string;
  tools: ToolDef[];
  cwd: string;
  permissionMode: PermissionMode;
  store: PermissionStore;
  onMessage(msg: EngineMessage): void;
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

interface StreamedTurn {
  blocks: ContentBlock[];
  stopReason: string | undefined;
  usage: Usage | undefined;
}

export class EngineLoop {
  messages: unknown[] = [];
  private model: string;
  private mode: PermissionMode;

  constructor(private opts: EngineOptions) {
    this.model = opts.model;
    this.mode = opts.permissionMode;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  async runTurn(userText: string, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    this.messages.push({ role: "user", content: userText });
    let usage: Usage | undefined;
    try {
      for (let i = 0; i < MAX_LOOP_TURNS; i++) {
        const turn = await this.streamOnce(signal);
        usage = turn.usage ?? usage;
        this.messages.push({ role: "assistant", content: turn.blocks });
        this.opts.onMessage(assistantMessage(turn.blocks));
        if (turn.stopReason !== "tool_use") break;
        const results = [];
        for (const block of turn.blocks) {
          if (block.type !== "tool_use") continue;
          results.push(await this.runTool(block));
        }
        this.messages.push({ role: "user", content: results });
      }
      this.opts.onMessage({ type: "result", subtype: "success", duration_ms: Date.now() - started, usage });
    } catch (err) {
      if (signal.aborted) {
        this.opts.onMessage({ type: "result", subtype: "success", duration_ms: Date.now() - started, usage });
      } else {
        this.opts.onMessage(errorResult(err instanceof Error ? err.message : String(err)));
      }
    }
  }

  private async streamOnce(signal: AbortSignal): Promise<StreamedTurn> {
    const blocks: ContentBlock[] = [];
    let pendingJson = "";
    let stopReason: string | undefined;
    let usage: Usage | undefined;
    const req = {
      model: this.model,
      system: this.opts.systemPrompt,
      messages: this.messages,
      tools: this.opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      max_tokens: MAX_TOKENS
    };
    for await (const event of this.opts.client.create(req, signal)) {
      const type = event.type as string;
      if (type === "content_block_start") {
        const cb = event.content_block as { type: string; text?: string; id?: string; name?: string };
        if (cb.type === "text") blocks.push({ type: "text", text: cb.text ?? "" });
        else if (cb.type === "tool_use") {
          blocks.push({ type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
          pendingJson = "";
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        const last = blocks[blocks.length - 1];
        if (delta.type === "text_delta" && last?.type === "text") {
          last.text += delta.text ?? "";
          this.opts.onMessage(textDelta(delta.text ?? ""));
        } else if (delta.type === "input_json_delta" && last?.type === "tool_use") {
          pendingJson += delta.partial_json ?? "";
        }
      } else if (type === "content_block_stop") {
        const last = blocks[blocks.length - 1];
        if (last?.type === "tool_use" && pendingJson.trim() !== "") {
          try {
            last.input = JSON.parse(pendingJson);
          } catch {
            last.input = {};
          }
          pendingJson = "";
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string };
        stopReason = delta.stop_reason ?? stopReason;
        if (event.usage) usage = event.usage as Usage;
      }
    }
    return { blocks, stopReason, usage };
  }

  private async runTool(block: { id: string; name: string; input: Record<string, unknown> }) {
    const deniedResult = (msg: string) => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: msg,
      is_error: true
    });
    const tool = this.opts.tools.find(t => t.name === block.name);
    if (!tool) return deniedResult(`Unknown tool: ${block.name}`);
    let decision = decidePermission(block.name, block.input, this.mode, this.opts.store);
    if (decision === "ask") {
      decision = (await this.opts.requestPermission(block.name, block.input)) ? "allow" : "deny";
    }
    if (decision === "deny") return deniedResult("User denied this tool use");
    try {
      const out = await tool.execute(block.input, { cwd: this.opts.cwd });
      return { type: "tool_result", tool_use_id: block.id, content: out.content, is_error: out.isError === true };
    } catch (err) {
      return deniedResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-loop.test.ts` — Expected: PASS (all 3). Then `npm run build` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts src/engine/api.ts tests/engine-loop.test.ts package.json package-lock.json
git commit -m "feat(engine): streaming agent loop with tool dispatch and permission gate"
```

---

### Task 7: Rewire AgentSession to the engine; remove the agent SDK

**Files:**
- Modify: `src/agent/session.ts` (replace `query()` internals; keep the public surface)
- Modify: `src/ui/App.tsx`, `src/ui/transcript.ts` (type imports only: `SDKMessage` → `EngineMessage` from `src/engine/messages.js`)
- Create: `src/engine/registry.ts`
- Modify: `package.json` (remove `@anthropic-ai/claude-agent-sdk`), `scripts/build-binaries.ps1`, `scripts/build-binaries.sh`, `scripts/bin-runtime.ts` (drop native-CLI embedding/extraction), delete `src/agent/nativeCli.ts`
- Test: existing suite + `tests/session.test.ts` if present (check first)

**Interfaces:**
- Consumes: `EngineLoop`, `EngineOptions` (Task 6), tools (Tasks 2–4), `makeClient` (Task 6).
- Produces: `AgentSession` with unchanged public members: `start()`, `send(text)`, `interrupt()`, `setModel(m)`, `setPermissionMode(m)`, `mcpStatus()`, `dispose()`, `sessionId`, `tools`, plus the same `onMessage`/`onPermissionRequest`/`onSessionId` callbacks. `registry.ts` exports `builtinTools(): ToolDef[]` returning `[readTool, writeTool, editTool, bashTool, globTool, grepTool]`.

Implementation sketch for `session.ts` internals (adapt names to the real file — the constructor options struct stays identical, `queryFn` option is removed):

```ts
// inside AgentSession
start(): void {
  this.sessionId = randomUUID();
  this.loop = new EngineLoop({
    client: makeClient(this.opts.provider),
    model: this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
    systemPrompt: buildSystemPrompt(this.opts.cwd),   // Task 9 expands; start with a constant string
    tools: builtinTools(),
    cwd: this.opts.cwd,
    permissionMode: this.opts.permissionMode,
    store: new PermissionStore(this.opts.cwd),
    onMessage: m => this.opts.onMessage(m as never),
    requestPermission: (toolName, input) =>
      new Promise(res => this.opts.onPermissionRequest({ toolName, input, resolve: res }))
  });
  this.tools = builtinTools().map(t => t.name);
  this.opts.onSessionId(this.sessionId);
  this.opts.onMessage({ type: "system", subtype: "init", session_id: this.sessionId, tools: this.tools } as never);
}

send(text: string): void {
  this.abort = new AbortController();
  void this.loop!.runTurn(text, this.abort.signal);
}

async interrupt(): Promise<void> { this.abort?.abort(); }
```

`DEFAULT_MODEL = "claude-sonnet-5"`. `mcpStatus()` returns `[]` until Task 11. `resume` option is accepted but ignored until Task 8. Delete the SDK import; `stream_event`/`assistant`/`result` shapes already match what `transcript.ts` reads, so its logic is untouched.

Steps:

- [ ] **Step 1: Create `src/engine/registry.ts`** (exports `builtinTools()`), rewrite `src/agent/session.ts` per the sketch, and switch `SDKMessage` type imports in `src/ui/App.tsx` and `src/ui/transcript.ts` to `EngineMessage`. Where App.tsx used other SDK types, replace with local structural types.
- [ ] **Step 2: `npm uninstall @anthropic-ai/claude-agent-sdk`**, delete `src/agent/nativeCli.ts`, remove the `pathToClaudeCodeExecutable`/`setNativeCliPath` wiring, and simplify `scripts/bin-runtime.ts` to only `setEmbeddedWelcome` + `import("../src/cli.js")` and both build scripts back to a single shared entry (restore a static `scripts/bin-entry.ts`, no generated per-target entries, no native package embedding).
- [ ] **Step 3: Run the full suite and build.** `npm run build && npx vitest run --exclude tests/skills.test.ts` — Expected: all pass. Fix type fallout until green.
- [ ] **Step 4: Smoke test against a live endpoint.** With `ANTHROPIC_API_KEY` set (or `--provider local` + llama.cpp running): `npm run dev`, ask "list the files in src/engine", confirm a Glob/Bash tool call round-trips and streams.
- [ ] **Step 5: Rebuild the portable exe and confirm it is small and standalone.** `npm run package:bin`; expected `release/cloudcode-win-x64.exe` well under 100 MB; run it from an outside directory.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: replace claude-agent-sdk with native engine (BREAKING: old sessions not resumable)"
```

---

### Task 8: Session persistence and resume

**Files:**
- Create: `src/engine/sessions.ts`
- Modify: `src/agent/session.ts` (persist after each turn; load on resume)
- Test: `tests/engine-sessions.test.ts`

**Interfaces:**
- Consumes: `EngineLoop.messages` (the API-shaped history array).
- Produces:

```ts
export class SessionFile {
  constructor(sessionId: string, dir?: string);      // dir default: join(configDir(), "sessions")
  append(entry: unknown): void;                      // one JSONL line per API message
  static load(sessionId: string, dir?: string): unknown[];  // [] if missing
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-sessions.test.ts
import { describe, it, expect } from "vitest";
import { SessionFile } from "../src/engine/sessions.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SessionFile", () => {
  it("round-trips appended messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "hi" });
    s.append({ role: "assistant", content: [{ type: "text", text: "hello" }] });
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] }
    ]);
  });
  it("returns empty array for unknown session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess2-"));
    expect(SessionFile.load("missing", dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/engine-sessions.test.ts`, FAIL.

- [ ] **Step 3: Implement**

```ts
// src/engine/sessions.ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../agent/providers.js";

const defaultDir = () => join(configDir(), "sessions");

export class SessionFile {
  private filePath: string;

  constructor(sessionId: string, dir: string = defaultDir()) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${sessionId}.jsonl`);
  }

  append(entry: unknown): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  static load(sessionId: string, dir: string = defaultDir()): unknown[] {
    try {
      return readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter(l => l.trim() !== "")
        .map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Wire into `AgentSession`.** In `start()`: if `this.opts.resume` is set, `this.loop.messages = SessionFile.load(this.opts.resume)` and reuse that id as `sessionId`. After `runTurn` resolves in `send()`, append the messages added during the turn (track `messages.length` before/after) to a `SessionFile(this.sessionId)`. Existing `SessionIndex` registration stays as is.
- [ ] **Step 5: Verify** — `npx vitest run tests/engine-sessions.test.ts` PASS; full suite green; manual check: `npm run dev`, say something, quit, `npm run dev -- --continue`, confirm prior context is known.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(engine): JSONL session persistence and resume"`

---

### Task 9: System prompt, CLAUDE.md, and skills injection

**Files:**
- Create: `src/engine/systemPrompt.ts`
- Modify: `src/agent/session.ts` (use `buildSystemPrompt`)
- Test: `tests/engine-system-prompt.test.ts`

**Interfaces:**
- Consumes: `loadSkills` and `Skill` from `src/agent/skills.js` (existing scanner; check its exact signature — `loadSkills(cwd, ...)` returns `Skill[]` with `name`/`description`/`content`).
- Produces: `buildSystemPrompt(cwd: string): string` — base agent prompt + `CLAUDE.md` contents (project root, if present) + a "Skills" section listing name+description, with instructions to read a skill's content via its path when relevant.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-system-prompt.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/engine/systemPrompt.js";

describe("buildSystemPrompt", () => {
  it("includes base prompt and cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sys-"));
    const p = buildSystemPrompt(dir);
    expect(p).toContain("coding agent");
    expect(p).toContain(dir);
  });
  it("appends CLAUDE.md when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sys2-"));
    writeFileSync(join(dir, "CLAUDE.md"), "Always use tabs.");
    expect(buildSystemPrompt(dir)).toContain("Always use tabs.");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

```ts
// src/engine/systemPrompt.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../agent/skills.js";

const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. Working directory: `;

export function buildSystemPrompt(cwd: string): string {
  let prompt = BASE + cwd;
  try {
    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf8").trim();
    if (claudeMd !== "") prompt += `\n\n# Project instructions (CLAUDE.md)\n${claudeMd}`;
  } catch {
    // no CLAUDE.md: skip section
  }
  const skills = loadSkills(cwd);
  if (skills.length > 0) {
    const list = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    prompt += `\n\n# Available skills\nWhen a task matches a skill, follow that skill's instructions.\n${list}`;
  }
  return prompt;
}
```

Adjust the `loadSkills` call to its real signature after reading `src/agent/skills.ts:101`.

- [ ] **Step 4: Verify PASS + full build**, replace the Task 7 placeholder prompt in `session.ts` with `buildSystemPrompt(this.opts.cwd)`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(engine): system prompt with CLAUDE.md and skills injection"`

---

### Task 10: MCP servers

**Files:**
- Create: `src/engine/mcpClient.ts`
- Modify: `src/agent/session.ts` (connect servers on start; merge tools; real `mcpStatus()`)
- Test: `tests/engine-mcp.test.ts`
- Run: `npm install @modelcontextprotocol/sdk` first.

**Interfaces:**
- Consumes: `McpServerConfig` from `src/agent/mcp.js` (`{ command, args?, env? }` for stdio servers); `ToolDef` from Task 1.
- Produces:

```ts
export class McpManager {
  connect(servers: Record<string, McpServerConfig>): Promise<void>; // failures recorded, not thrown
  tools(): ToolDef[];         // namespaced mcp__<server>__<tool>
  status(): McpServerStatusEntry[];
  dispose(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test** (unit-level, no real server: test namespacing and status bookkeeping with an injected fake client factory)

```ts
// tests/engine-mcp.test.ts
import { describe, it, expect } from "vitest";
import { McpManager } from "../src/engine/mcpClient.js";

const fakeFactory = async () => ({
  listTools: async () => ({ tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }] }),
  callTool: async (req: { name: string }) => ({ content: [{ type: "text", text: `ran:${req.name}` }] }),
  close: async () => {}
});

describe("McpManager", () => {
  it("namespaces tools and reports connected status", async () => {
    const mgr = new McpManager(fakeFactory as never);
    await mgr.connect({ myserver: { command: "irrelevant" } });
    expect(mgr.tools().map(t => t.name)).toEqual(["mcp__myserver__search"]);
    expect(mgr.status()).toEqual([{ name: "myserver", status: "connected" }]);
    const out = await mgr.tools()[0].execute({}, { cwd: "." });
    expect(out.content).toContain("ran:search");
  });
  it("records failed servers without throwing", async () => {
    const mgr = new McpManager((async () => { throw new Error("spawn failed"); }) as never);
    await mgr.connect({ bad: { command: "nope" } });
    expect(mgr.status()).toEqual([{ name: "bad", status: "failed" }]);
    expect(mgr.tools()).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL**, then **Step 3: Implement**

```ts
// src/engine/mcpClient.ts
import type { McpServerConfig, McpServerStatusEntry } from "../agent/mcp.js";
import type { ToolDef } from "./tools/types.js";

// Minimal facade over an MCP client connection; the default factory uses
// @modelcontextprotocol/sdk Client + StdioClientTransport.
export interface McpConnection {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}

export type ConnectionFactory = (name: string, cfg: McpServerConfig) => Promise<McpConnection>;

async function defaultFactory(name: string, cfg: McpServerConfig): Promise<McpConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: String(cfg.command ?? ""),
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    env: (cfg.env as Record<string, string>) ?? undefined
  });
  const client = new Client({ name: "cloudcode", version: "0.1.0" });
  await client.connect(transport);
  return client as unknown as McpConnection;
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private states: McpServerStatusEntry[] = [];
  private toolDefs: ToolDef[] = [];

  constructor(private factory: ConnectionFactory = defaultFactory) {}

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const conn = await this.factory(name, cfg);
        this.connections.set(name, conn);
        const { tools } = await conn.listTools();
        for (const t of tools) {
          this.toolDefs.push({
            name: `mcp__${name}__${t.name}`,
            description: t.description ?? "",
            input_schema: t.inputSchema,
            execute: async input => {
              const res = await conn.callTool({ name: t.name, arguments: input });
              const text = res.content.map(c => c.text ?? "").join("\n");
              return { content: text || "(no output)" };
            }
          });
        }
        this.states.push({ name, status: "connected" });
      } catch {
        this.states.push({ name, status: "failed" });
      }
    }
  }

  tools(): ToolDef[] {
    return this.toolDefs;
  }

  status(): McpServerStatusEntry[] {
    return this.states;
  }

  async dispose(): Promise<void> {
    for (const conn of this.connections.values()) await conn.close().catch(() => {});
    this.connections.clear();
  }
}
```

- [ ] **Step 4: Wire into `AgentSession`:** in `start()`, `const mcp = new McpManager(); await mcp.connect(this.opts.mcpServers ?? {})` (make `start` async or fire-and-forget with a ready promise before first `send`); tools = `[...builtinTools(), ...mcp.tools()]`; `mcpStatus()` returns `mcp.status()`; `dispose()` calls `mcp.dispose()`. MCP tools are gated like Bash: `"ask"` unless bypass.
- [ ] **Step 5: Verify** unit tests PASS, suite green, `/mcp` in the TUI shows configured servers.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(engine): MCP stdio servers via official client SDK"`

---

### Task 11: /compact, prompt caching, and cost tracking

**Files:**
- Create: `src/engine/compact.ts`, `src/engine/pricing.ts`
- Modify: `src/engine/loop.ts` (cache_control markers; cost in result), `src/commands/builtins.ts` (point `/compact` at the engine — read how it currently invokes compaction first)
- Test: `tests/engine-compact.test.ts`, `tests/engine-pricing.test.ts`

**Interfaces:**
- Consumes: `EngineLoop.messages`, `MessagesClient`.
- Produces: `compactHistory(client, model, messages): Promise<unknown[]>` — returns `[{ role: "user", content: "Summary of prior conversation: …" }]`; `costUsd(model: string, usage: Usage): number | undefined` (undefined for unknown models, so local providers show no cost).

- [ ] **Step 1: Write failing tests**

```ts
// tests/engine-pricing.test.ts
import { describe, it, expect } from "vitest";
import { costUsd } from "../src/engine/pricing.js";

describe("costUsd", () => {
  it("prices a known model", () => {
    const c = costUsd("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(c).toBeGreaterThan(0);
  });
  it("returns undefined for unknown models", () => {
    expect(costUsd("qwen2.5-coder-32b", { input_tokens: 100, output_tokens: 100 })).toBeUndefined();
  });
});
```

```ts
// tests/engine-compact.test.ts
import { describe, it, expect } from "vitest";
import { compactHistory } from "../src/engine/compact.js";

const fakeClient = {
  async *create() {
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never;
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "user asked about X" } } as never;
    yield { type: "message_stop" } as never;
  }
};

describe("compactHistory", () => {
  it("replaces history with a single summary user message", async () => {
    const next = await compactHistory(fakeClient as never, "m", [{ role: "user", content: "long stuff" }]);
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next[0])).toContain("user asked about X");
  });
});
```

- [ ] **Step 2: FAIL**, then **Step 3: Implement**

```ts
// src/engine/pricing.ts
import type { Usage } from "./messages.js";

// USD per million tokens: [input, output]. Extend as models are used.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [3, 15],
  "claude-opus-4-8": [15, 75],
  "claude-haiku-4-5-20251001": [1, 5]
};

export function costUsd(model: string, usage: Usage): number | undefined {
  const p = Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1];
  if (!p) return undefined;
  return (usage.input_tokens * p[0] + usage.output_tokens * p[1]) / 1_000_000;
}
```

```ts
// src/engine/compact.ts
import type { MessagesClient } from "./api.js";

const PROMPT = "Summarize the conversation so far for your own future reference: key facts, decisions, code locations, and open tasks. Be dense and complete.";

export async function compactHistory(
  client: MessagesClient,
  model: string,
  messages: unknown[]
): Promise<unknown[]> {
  let summary = "";
  const req = {
    model,
    system: "You compress agent conversation history.",
    messages: [...messages, { role: "user", content: PROMPT }],
    tools: [],
    max_tokens: 2048
  };
  for await (const event of client.create(req, new AbortController().signal)) {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") summary += e.delta.text ?? "";
  }
  return [{ role: "user", content: `Summary of prior conversation: ${summary}` }];
}
```

- [ ] **Step 4: Wire up.** In `loop.ts` request assembly: `system` becomes `[{ type: "text", text: this.opts.systemPrompt, cache_control: { type: "ephemeral" } }]`, and add `cache_control: { type: "ephemeral" }` to the last content block of the final message in `messages` (remove the marker from the previous holder each turn). In the success result, set `total_cost_usd: costUsd(this.model, usage)` accumulated across loop iterations. Point `/compact` at `loop.messages = await compactHistory(...)`.
- [ ] **Step 5: Verify** — new tests PASS, full suite green (`npx vitest run --exclude tests/skills.test.ts`), `npm run build` exit 0. Manual: `/compact` in a live session shrinks context and the next reply still knows the summary; cost shows for Anthropic models and is absent for `--provider local`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(engine): compaction, prompt caching, cost tracking"`

---

### Task 12: Final verification and docs

**Files:**
- Modify: `README.md` (remove agent-SDK/native-binary wording; document engine, auth, session format break)
- Modify: `docs/superpowers/specs/2026-07-11-native-engine-design.md` (status → Implemented)

- [ ] **Step 1: Full gate.** `npm run build && npx vitest run --exclude tests/skills.test.ts` — all green.
- [ ] **Step 2: Live smoke.** `npm run dev`: multi-tool task ("find where sessions are stored and add a comment"), permission dialog appears for Write/Edit in default mode, Esc interrupts mid-stream, `--continue` resumes.
- [ ] **Step 3: Portable exe.** `npm run package:bin`; verify `release/cloudcode-win-x64.exe` size (expect < 100 MB), run from an outside directory, confirm no `~/.cloudcode/bin/claude-*.exe` is created.
- [ ] **Step 4: Update README** — Setup/auth section (API key required), remove claude.exe embedding paragraph, note session-format break.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs: native engine README and spec status"`
