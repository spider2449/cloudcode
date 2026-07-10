# cloudcode v2 Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the UX gap with real Claude Code: token streaming, markdown + syntax highlighting, a working-state spinner, and an upgraded input box (cursor, history, multi-line).

**Architecture:** Four targeted upgrades to the existing v1 code. Streaming uses the SDK's `includePartialMessages` and a `streamText` state in App rendered below the transcript. Markdown conversion is a pure function (`marked` + `marked-terminal`) applied to finalized assistant text at render time. The spinner is a self-ticking Ink component driven by App's phase. The input box keeps the chunk-safe handler (do NOT adopt ink-text-input — its submit-on-key.return would reintroduce the paste bug fixed in 5a343bf) and gains a cursor index, persistent history, and backslash continuation.

**Tech Stack:** Existing v1 stack + `marked`, `marked-terminal`, `ink-spinner`.

## Global Constraints

- ALL code, comments, docs, identifiers in English only.
- ESM; relative imports end in `.js`; Node >= 18.
- Spec: `docs/superpowers/specs/2026-07-10-cloudcode-v2-polish-design.md`.
- Config dir `~/.cloudcode/` gains `history.json` (most recent 100 entries).
- Markdown/history failures must never crash: fall back to raw text / empty history.
- Streaming text renders as plain text; only finalized assistant text gets markdown.
- Diff previews capped at 20 lines + `… (+N more)` tail.
- Existing tests must keep passing; existing public interfaces (AgentSession, CommandContext, DisplayItem consumers) must not break except where a task explicitly extends them.

---

### Task 1: Markdown renderer

**Files:**
- Create: `src/ui/markdown.ts`
- Modify: `package.json` (deps)
- Test: `tests/markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(text: string): string` — ANSI-styled string; returns `text` unchanged on any parse error.

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install marked marked-terminal ink-spinner
npm install -D @types/marked-terminal
```
Expected: no errors. If `@types/marked-terminal` does not exist for the installed major version, skip it and use a local `declare module "marked-terminal";` in `src/ui/markdown.ts` via `// @ts-expect-error` on the import instead.

- [ ] **Step 2: Write failing test**

```ts
// tests/markdown.test.ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/ui/markdown.js";

describe("renderMarkdown", () => {
  it("styles bold text (output differs from input, keeps content)", () => {
    const out = renderMarkdown("**bold** word");
    expect(out).toContain("bold");
    expect(out).toContain("word");
    expect(out).not.toBe("**bold** word");
  });

  it("renders code blocks with their content preserved", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
  });

  it("falls back to raw text when the renderer throws", () => {
    // A lone surrogate can break downstream renderers; whatever the trigger,
    // the contract is: never throw, return something containing the input.
    const weird = "text with \ud800 lone surrogate";
    expect(() => renderMarkdown(weird)).not.toThrow();
    expect(renderMarkdown("plain")).toContain("plain");
  });
});
```

Run: `npx vitest run tests/markdown.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/ui/markdown.ts`**

Check the installed `marked-terminal` major version in `node_modules/marked-terminal/package.json` and use the matching integration. For v7+:

```ts
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(markedTerminal());

export function renderMarkdown(text: string): string {
  try {
    const out = marked.parse(text, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
```

For v6 and older (class API), instead:

```ts
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

marked.setOptions({ renderer: new TerminalRenderer() as never });

export function renderMarkdown(text: string): string {
  try {
    const out = marked.parse(text) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
```

Run: `npx vitest run tests/markdown.test.ts` — Expected: PASS. If the bold assertion fails because the test environment strips colors, force color support: add `process.env.FORCE_COLOR = "3";` as the first line of the test file (before imports is not possible in ESM — put it in a `beforeAll` and re-require, or simply assert `out.length >= input.length` instead; prefer the simplest passing honest assertion and note it in the report).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/ui/markdown.ts tests/markdown.test.ts
git commit -m "feat: markdown renderer with terminal styling"
```

---

### Task 2: Command history

**Files:**
- Create: `src/agent/history.ts`
- Test: `tests/history.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/agent/providers.js`.
- Produces:
  ```ts
  class History {
    constructor(filePath?: string);          // default: join(configDir(), "history.json")
    add(text: string): void;                  // appends, dedupes consecutive, caps at 100, persists, resets cursor
    back(): string | undefined;               // older entry; undefined past the oldest (stays at oldest)
    forward(): string | undefined;            // newer entry; undefined (and cursor reset) past the newest
    resetCursor(): void;
  }
  ```
- Semantics: cursor starts past-the-end. `back()` from fresh cursor returns the most recent entry. `forward()` at the newest returns `undefined` meaning "leave history, restore draft" (caller handles the draft). Corrupt/missing file → empty history.

- [ ] **Step 1: Write failing tests**

```ts
// tests/history.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "../src/agent/history.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "cc-")), "history.json");
}

describe("History", () => {
  it("navigates back and forward", () => {
    const h = new History(tempFile());
    h.add("first");
    h.add("second");
    expect(h.back()).toBe("second");
    expect(h.back()).toBe("first");
    expect(h.back()).toBe("first");        // stays at oldest
    expect(h.forward()).toBe("second");
    expect(h.forward()).toBeUndefined();   // past newest -> leave history
  });

  it("persists across instances and caps at 100", () => {
    const file = tempFile();
    const a = new History(file);
    for (let i = 0; i < 150; i++) a.add(`cmd${i}`);
    const b = new History(file);
    expect(b.back()).toBe("cmd149");
    let count = 1;
    while (b.back() !== "cmd50") count++;
    expect(count).toBe(100);
  });

  it("dedupes consecutive duplicates", () => {
    const h = new History(tempFile());
    h.add("same");
    h.add("same");
    expect(h.back()).toBe("same");
    expect(h.back()).toBe("same"); // only one entry; stays at oldest
    expect(h.forward()).toBeUndefined();
  });

  it("tolerates a corrupt file", () => {
    const file = tempFile();
    writeFileSync(file, "{nope");
    const h = new History(file);
    expect(h.back()).toBeUndefined();
  });
});
```

Run: `npx vitest run tests/history.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/agent/history.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

const MAX_ENTRIES = 100;

export class History {
  private entries: string[] = [];
  private cursor: number;

  constructor(private filePath: string = join(configDir(), "history.json")) {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.entries = raw.filter(e => typeof e === "string");
    } catch {
      // missing or invalid file: start empty
    }
    this.cursor = this.entries.length;
  }

  add(text: string): void {
    if (this.entries[this.entries.length - 1] !== text) {
      this.entries.push(text);
      if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    }
    this.resetCursor();
  }

  back(): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor > 0) this.cursor--;
    return this.entries[this.cursor];
  }

  forward(): string | undefined {
    if (this.cursor >= this.entries.length - 1) {
      this.resetCursor();
      return undefined;
    }
    this.cursor++;
    return this.entries[this.cursor];
  }

  resetCursor(): void {
    this.cursor = this.entries.length;
  }
}
```

Run: `npx vitest run tests/history.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/history.ts tests/history.test.ts
git commit -m "feat: persistent command history"
```

---

### Task 3: Transcript streaming deltas and diff previews

**Files:**
- Modify: `src/ui/transcript.ts`
- Test: `tests/transcript.test.ts` (extend)

**Interfaces:**
- Consumes: existing `DisplayItem`, `SDKMessage`.
- Produces:
  - `type DiffLine = { sign: "+" | "-" | " "; text: string }`
  - `DisplayItem` union gains `| { kind: "diff"; lines: DiffLine[] }`
  - `streamDelta(msg: SDKMessage): string | undefined` — text delta from a `stream_event` message, else undefined.
  - `diffLines(name: string, input: Record<string, unknown>, cap?: number): DiffLine[]` — Edit → `-` lines from `old_string` then `+` lines from `new_string`; Write → `+` lines from `content`; other tools → `[]`. Over `cap` (default 20): truncate and append `{ sign: " ", text: "… (+N more)" }`.
  - `toDisplayItems` additionally emits a `diff` item immediately after the `tool` item for Edit/Write tool_use blocks (only when `diffLines` returns non-empty).

- [ ] **Step 1: Write failing tests (append to tests/transcript.test.ts)**

```ts
import { streamDelta, diffLines } from "../src/ui/transcript.js";

describe("streamDelta", () => {
  it("extracts text deltas from stream events", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } }
    } as unknown as SDKMessage;
    expect(streamDelta(msg)).toBe("hel");
  });

  it("returns undefined for other messages and non-text deltas", () => {
    expect(streamDelta({ type: "assistant", message: { content: [] } } as unknown as SDKMessage)).toBeUndefined();
    expect(streamDelta({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } }
    } as unknown as SDKMessage)).toBeUndefined();
  });
});

describe("diffLines", () => {
  it("maps Edit old/new strings to -/+ lines", () => {
    expect(diffLines("Edit", { old_string: "a\nb", new_string: "c" })).toEqual([
      { sign: "-", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "c" }
    ]);
  });

  it("maps Write content to + lines and caps with ellipsis", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = diffLines("Write", { content });
    expect(lines).toHaveLength(21);
    expect(lines[20]).toEqual({ sign: " ", text: "… (+10 more)" });
  });

  it("returns empty for other tools", () => {
    expect(diffLines("Bash", { command: "ls" })).toEqual([]);
  });
});

describe("toDisplayItems diff emission", () => {
  it("emits a diff item after Edit tool chips", () => {
    const msg = {
      type: "assistant",
      message: { content: [
        { type: "tool_use", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }
      ] }
    } as unknown as SDKMessage;
    const items = toDisplayItems(msg);
    expect(items[0].kind).toBe("tool");
    expect(items[1]).toEqual({
      kind: "diff",
      lines: [{ sign: "-", text: "a" }, { sign: "+", text: "b" }]
    });
  });
});
```

Run: `npx vitest run tests/transcript.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement in `src/ui/transcript.ts`**

Add to the existing file (keep everything already there; extend the `DisplayItem` union):

```ts
export type DiffLine = { sign: "+" | "-" | " "; text: string };

// add to DisplayItem union:
//  | { kind: "diff"; lines: DiffLine[] }

export function streamDelta(msg: SDKMessage): string | undefined {
  const m = msg as Record<string, unknown>;
  if (m.type !== "stream_event") return undefined;
  const event = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text;
  }
  return undefined;
}

export function diffLines(name: string, input: Record<string, unknown>, cap = 20): DiffLine[] {
  const lines: DiffLine[] = [];
  if (name === "Edit") {
    if (typeof input.old_string === "string" && input.old_string !== "") {
      for (const l of input.old_string.split("\n")) lines.push({ sign: "-", text: l });
    }
    if (typeof input.new_string === "string" && input.new_string !== "") {
      for (const l of input.new_string.split("\n")) lines.push({ sign: "+", text: l });
    }
  } else if (name === "Write") {
    if (typeof input.content === "string" && input.content !== "") {
      for (const l of input.content.split("\n")) lines.push({ sign: "+", text: l });
    }
  }
  if (lines.length > cap) {
    const extra = lines.length - cap;
    return [...lines.slice(0, cap), { sign: " ", text: `… (+${extra} more)` }];
  }
  return lines;
}
```

In `toDisplayItems`, inside the `tool_use` branch, after pushing the `tool` item:

```ts
const dl = diffLines(String(block.name), (block.input ?? {}) as Record<string, unknown>);
if (dl.length > 0) items.push({ kind: "diff", lines: dl });
```

Run: `npx vitest run tests/transcript.test.ts` — Expected: PASS. Then `npx tsc --noEmit` — Expected: errors in `MessageList.tsx` (unhandled `diff` case) are acceptable ONLY if TypeScript flags them; if it does, add the render case now (see Task 5 Step 2 for the exact JSX) and note it in the report; if it compiles (switch without exhaustiveness), leave MessageList to Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/ui/transcript.ts tests/transcript.test.ts
git commit -m "feat: stream deltas and Edit/Write diff previews in transcript"
```

---

### Task 4: WorkingIndicator and streaming session flag

**Files:**
- Create: `src/ui/WorkingIndicator.tsx`
- Modify: `src/agent/session.ts` (add `includePartialMessages: true` to query options)
- Test: `tests/workingIndicator.test.tsx`

**Interfaces:**
- Consumes: `ink-spinner` (installed in Task 1).
- Produces: `WorkingIndicator({ label, startedAt }: { label: string; startedAt: number })` — renders `<Spinner/> {label}… (Ns · Esc to interrupt)` where N is whole seconds since `startedAt`, self-updating every second.
- Session change: `query()` options gain `includePartialMessages: true` (unconditional).

- [ ] **Step 1: Write failing test**

```tsx
// tests/workingIndicator.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { WorkingIndicator } from "../src/ui/WorkingIndicator.js";

describe("WorkingIndicator", () => {
  it("shows label and elapsed seconds", () => {
    const { lastFrame } = render(<WorkingIndicator label="Running Bash" startedAt={Date.now() - 3500} />);
    expect(lastFrame()).toContain("Running Bash…");
    expect(lastFrame()).toMatch(/\(3s · Esc to interrupt\)/);
  });
});
```

Run: `npx vitest run tests/workingIndicator.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `src/ui/WorkingIndicator.tsx`**

```tsx
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import Spinner from "ink-spinner";

interface Props {
  label: string;
  startedAt: number;
}

export function WorkingIndicator({ label, startedAt }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text color="cyan">
      <Spinner type="dots" /> {label}… <Text color="gray">({seconds}s · Esc to interrupt)</Text>
    </Text>
  );
}
```

Run: `npx vitest run tests/workingIndicator.test.tsx` — Expected: PASS.

- [ ] **Step 3: Add the streaming flag to `src/agent/session.ts`**

In `start()`, inside the `options` object passed to `queryFn`, add:

```ts
includePartialMessages: true,
```

Run: `npx vitest run tests/session.test.ts` and `npx tsc --noEmit` — Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui/WorkingIndicator.tsx tests/workingIndicator.test.tsx src/agent/session.ts
git commit -m "feat: working indicator and partial-message streaming flag"
```

---

### Task 5: MessageList markdown + diff rendering

**Files:**
- Modify: `src/ui/MessageList.tsx`
- Test: `tests/messageList.test.tsx` (extend)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 1), `DiffLine`/`diff` item (Task 3).
- Produces: assistant items render through `renderMarkdown`; `diff` items render as green `+`, red `-`, gray context lines, indented two spaces.

- [ ] **Step 1: Write failing tests (append to tests/messageList.test.tsx)**

```tsx
it("renders diff items with signs", () => {
  const { lastFrame } = render(
    <MessageList items={[
      { kind: "diff", lines: [{ sign: "-", text: "old line" }, { sign: "+", text: "new line" }] }
    ]} />
  );
  expect(lastFrame()).toContain("- old line");
  expect(lastFrame()).toContain("+ new line");
});

it("renders assistant markdown (bold survives as text)", () => {
  const { lastFrame } = render(
    <MessageList items={[{ kind: "assistant", text: "**hello** world" }]} />
  );
  expect(lastFrame()).toContain("hello");
  expect(lastFrame()).toContain("world");
  expect(lastFrame()).not.toContain("**hello**");
});
```

Run: `npx vitest run tests/messageList.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement in `src/ui/MessageList.tsx`**

Add the import and two cases:

```tsx
import { renderMarkdown } from "./markdown.js";
```

Change the `assistant` case to:

```tsx
case "assistant":
  return <Text key={i}>{renderMarkdown(item.text)}</Text>;
```

Add a `diff` case:

```tsx
case "diff":
  return (
    <Box key={i} flexDirection="column" marginLeft={2}>
      {item.lines.map((l, j) => (
        <Text key={j} color={l.sign === "+" ? "green" : l.sign === "-" ? "red" : "gray"}>
          {l.sign} {l.text}
        </Text>
      ))}
    </Box>
  );
```

Run: `npx vitest run tests/messageList.test.tsx` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/MessageList.tsx tests/messageList.test.tsx
git commit -m "feat: markdown and diff rendering in transcript"
```

---

### Task 6: InputBox cursor, history, multi-line

**Files:**
- Modify: `src/ui/InputBox.tsx`
- Test: `tests/inputBox.test.tsx` (extend)

**Interfaces:**
- Consumes: `History` class (Task 2).
- Produces: `InputBox` props gain `history: History` (required). Behavior added:
  - Left/Right arrows move a cursor; insertion/backspace act at the cursor; block cursor `█` rendered at the cursor position.
  - Up/Down recall history (`back()`/`forward()`); recalling replaces the value; `forward()` past the newest restores the draft that was being typed before recall began.
  - A value ending in `\` submits as a continuation: Enter replaces the trailing `\` with `\n` and editing continues; final submit sends the joined multi-line text.
  - Chunk-safe processing from 5a343bf is preserved (multi-char chunks split on CR/LF, ref-based state).
- App (Task 7) constructs the `History` and passes it in; tests construct `new History(<temp file>)`.

- [ ] **Step 1: Write failing tests (append to tests/inputBox.test.tsx)**

Add imports at the top of the file:

```tsx
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "../src/agent/history.js";

const tempHistory = () => new History(join(mkdtempSync(join(tmpdir(), "cc-")), "history.json"));
```

Update ALL existing `render(<InputBox ...>)` calls in this file to pass `history={tempHistory()}`. Then add:

```tsx
it("moves the cursor left and inserts at the cursor", async () => {
  const onSubmit = vi.fn();
  const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
  await wait();
  stdin.write("ac");
  await wait();
  stdin.write("[D"); // left arrow
  await wait();
  stdin.write("b");
  await wait();
  stdin.write("\r");
  await wait();
  expect(onSubmit).toHaveBeenCalledWith("abc");
});

it("recalls history with up arrow and restores draft with down arrow", async () => {
  const onSubmit = vi.fn();
  const history = tempHistory();
  history.add("previous command");
  const { stdin, lastFrame } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} history={history} />);
  await wait();
  stdin.write("draft");
  await wait();
  stdin.write("[A"); // up arrow
  await wait();
  expect(lastFrame()).toContain("previous command");
  stdin.write("[B"); // down arrow
  await wait();
  expect(lastFrame()).toContain("draft");
});

it("adds submitted text to history", async () => {
  const history = tempHistory();
  const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={() => {}} disabled={false} history={history} />);
  await wait();
  stdin.write("remember me\r");
  await wait();
  expect(history.back()).toBe("remember me");
});

it("continues to a new line when the line ends with backslash", async () => {
  const onSubmit = vi.fn();
  const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
  await wait();
  stdin.write("line one\\");
  await wait();
  stdin.write("\r");
  await wait();
  expect(onSubmit).not.toHaveBeenCalled();
  stdin.write("line two");
  await wait();
  stdin.write("\r");
  await wait();
  expect(onSubmit).toHaveBeenCalledWith("line one\nline two");
});
```

Run: `npx vitest run tests/inputBox.test.tsx` — Expected: new tests FAIL (missing prop is a type error at test-compile time — that counts).

- [ ] **Step 2: Rewrite `src/ui/InputBox.tsx`**

```tsx
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { completions } from "../commands/registry.js";
import type { Command } from "../commands/types.js";
import type { History } from "../agent/history.js";

interface Props {
  registry: Map<string, Command>;
  onSubmit(text: string): void;
  disabled: boolean;
  history: History;
}

export function InputBox({ registry, onSubmit, disabled, history }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  // Terminals can deliver many keypresses in one stdin chunk (paste, fast
  // typing), so the handler may fire several times before React re-renders;
  // refs keep the authoritative state instead of a stale render closure.
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  // Draft saved when the user starts recalling history with the up arrow.
  const draftRef = useRef<string | undefined>(undefined);

  const update = (nextValue: string, nextCursor: number) => {
    valueRef.current = nextValue;
    cursorRef.current = Math.max(0, Math.min(nextCursor, nextValue.length));
    setValue(valueRef.current);
    setCursor(cursorRef.current);
  };

  const submit = () => {
    const current = valueRef.current;
    if (current.endsWith("\\")) {
      // Line continuation: swap the trailing backslash for a newline.
      update(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    update("", 0);
    draftRef.current = undefined;
    history.resetCursor();
    if (text) {
      history.add(text);
      onSubmit(text);
    }
  };

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl || key.meta) return;
    if (key.leftArrow) {
      update(valueRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      update(valueRef.current, cursorRef.current + 1);
      return;
    }
    if (key.upArrow) {
      if (draftRef.current === undefined) draftRef.current = valueRef.current;
      const recalled = history.back();
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
      const recalled = history.forward();
      if (recalled !== undefined) {
        update(recalled, recalled.length);
      } else {
        update(draftRef.current ?? "", (draftRef.current ?? "").length);
        draftRef.current = undefined;
      }
      return;
    }
    if (key.backspace || key.delete) {
      const v = valueRef.current;
      const c = cursorRef.current;
      if (c > 0) update(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }
    if (key.tab) {
      const m = /^\/(\w*)$/.exec(valueRef.current);
      if (m) {
        const matches = completions(registry, m[1]);
        if (matches.length === 1) update(`/${matches[0]} `, matches[0].length + 2);
      }
      return;
    }
    if (key.return && !input) {
      submit();
      return;
    }
    // A chunk may mix text and line endings; split it so each line submits.
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        submit();
      } else if (ch >= " ") {
        const v = valueRef.current;
        const c = cursorRef.current;
        update(v.slice(0, c) + ch + v.slice(c), c + 1);
      }
    }
  });

  const slashMatch = /^\/(\w*)$/.exec(value);
  const hints = slashMatch ? completions(registry, slashMatch[1]) : [];
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>{"> "}{before}{disabled ? "" : "█"}{after}</Text>
      </Box>
      {disabled && <Text color="gray">working… (Esc to interrupt)</Text>}
      {!disabled && hints.length > 0 && (
        <Text color="gray">{hints.map(h => `/${h}`).join("  ")}</Text>
      )}
    </Box>
  );
}
```

Note: `tests/app.test.tsx` renders App, which constructs InputBox — App still compiles because it doesn't pass `history` yet. Task 7 wires it. To keep this task self-contained and the suite green, make the prop OPTIONAL for now is NOT allowed (later tasks rely on it being required); instead, this task also does the one-line App change: in `src/ui/App.tsx`, add

```tsx
import { History } from "../agent/history.js";
```

inside the component: `const historyRef = useRef(new History());` and pass `history={historyRef.current}` to `<InputBox ... />`.

Run: `npx vitest run` — Expected: ALL tests pass (including existing InputBox chunk tests). `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ui/InputBox.tsx src/ui/App.tsx tests/inputBox.test.tsx
git commit -m "feat: input cursor movement, history recall, line continuation"
```

---

### Task 7: App streaming wiring

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx` (extend)

**Interfaces:**
- Consumes: `streamDelta` (Task 3), `WorkingIndicator` (Task 4).
- Produces (behavior):
  - App accumulates `stream_event` text deltas into a `streamText` string state (ref-backed), rendered as plain gray-white text between `MessageList` and the dialogs/input.
  - Any assistant item arriving clears `streamText` (the final message replaces the partial text).
  - On `result`: if `streamText` is non-empty (interrupt/no final message), it is appended to items as an `assistant` item, then cleared.
  - `activeTool` state: set to the tool name when a `tool` item is mapped, cleared when assistant text or `result` arrives. While phase is `streaming`, render `<WorkingIndicator label={activeTool ? `Running ${activeTool}` : "Thinking"} startedAt={workStartedAt} />` (replacing the InputBox's static "working…" hint line visually is fine — keep InputBox `disabled` as-is).
  - `workStartedAt` set to `Date.now()` in `handleSubmit` when a plain message is sent.

- [ ] **Step 1: Write failing test (append to tests/app.test.tsx)**

```tsx
it("streams partial text then replaces it with the final message", async () => {
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  let releaseFinal: () => void = () => {};
  const gate = new Promise<void>(r => { releaseFinal = r; });
  const streamingQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const _ of args.prompt) {
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "par" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "tial" } } };
        await gate;
        yield { type: "assistant", message: { content: [{ type: "text", text: "partial and final" }] } };
        yield { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 100 };
      }
    })();
    return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
  };
  const { stdin, lastFrame, frames } = render(
    <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} queryFn={streamingQueryFn as never} />
  );
  await wait();
  stdin.write("go");
  await wait();
  stdin.write("\r");
  await wait(100);
  expect(lastFrame()).toContain("partial");          // partial text visible while gated
  releaseFinal();
  await wait(100);
  expect(lastFrame()).toContain("partial and final"); // final replaces it
  const finalFrame = lastFrame()!;
  expect(finalFrame.match(/partial/g)!.length).toBe(1); // no duplicate partial+final
});

it("shows the working indicator while streaming", async () => {
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  const neverEndingQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const _ of args.prompt) {
        await new Promise(() => {}); // never resolves
      }
    })();
    return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
  };
  const { stdin, lastFrame } = render(
    <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} queryFn={neverEndingQueryFn as never} />
  );
  await wait();
  stdin.write("go");
  await wait();
  stdin.write("\r");
  await wait(100);
  expect(lastFrame()).toContain("Thinking…");
});
```

Run: `npx vitest run tests/app.test.tsx` — Expected: new tests FAIL.

- [ ] **Step 2: Implement in `src/ui/App.tsx`**

Add imports:

```tsx
import { streamDelta } from "./transcript.js";
import { WorkingIndicator } from "./WorkingIndicator.js";
```

Add state and refs near the other state:

```tsx
const [streamText, setStreamText] = useState("");
const streamRef = useRef("");
const [activeTool, setActiveTool] = useState<string | undefined>(undefined);
const [workStartedAt, setWorkStartedAt] = useState(0);
```

Helper (near `notice`):

```tsx
const setStream = (text: string) => { streamRef.current = text; setStreamText(text); };
```

Extend `handleMessage` — at the top:

```tsx
const delta = streamDelta(msg);
if (delta) { setStream(streamRef.current + delta); return; }
```

After computing `mapped`:

```tsx
if (mapped.some(i => i.kind === "assistant")) { setStream(""); setActiveTool(undefined); }
const lastTool = [...mapped].reverse().find(i => i.kind === "tool");
if (lastTool && lastTool.kind === "tool") setActiveTool(lastTool.label.split(" ")[0]);
```

In the `result` branch (before `setPhase("idle")`):

```tsx
if (streamRef.current) {
  const text = streamRef.current;
  setItems(prev => [...prev, { kind: "assistant", text }]);
  setStream("");
}
setActiveTool(undefined);
```

In `handleSubmit`, next to `setPhase("streaming")`:

```tsx
setWorkStartedAt(Date.now());
```

In the JSX, after `<MessageList items={items} />`:

```tsx
{streamText !== "" && <Text>{streamText}</Text>}
{phase === "streaming" && <WorkingIndicator label={activeTool ? `Running ${activeTool}` : "Thinking"} startedAt={workStartedAt} />}
```

(`Text` needs importing from `ink` if not already.) Also clear stream state in `clearSession`'s ctx entry: add `setStream(""); setActiveTool(undefined);` before `restartSession`.

Run: `npx vitest run` — Expected: ALL tests pass. `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Update README**

Add to README.md under Commands section:

```markdown
## UX

Streaming output renders token by token; assistant replies render as markdown with
syntax-highlighted code blocks; Edit/Write tools show a colored diff preview.
Input supports cursor movement (←/→), command history (↑/↓, persisted to
~/.cloudcode/history.json), and multi-line input (end a line with \ and press Enter).
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx tests/app.test.tsx README.md
git commit -m "feat: wire token streaming and working indicator into App"
```
