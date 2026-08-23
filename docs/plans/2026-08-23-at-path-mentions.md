# @path Mention Anchoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor `@path` tokens in submitted messages: teach the model the convention via the system prompt and warn on nonexistent paths, without embedding file contents.

**Architecture:** A pure `src/commands/mentions.ts` module extracts and validates mentions; `engine/systemPrompt.ts` gains one convention line; `nativeApp.sendUserMessage` warns on misses before sending. The existing UI-side completion (`fileSuggestions`) is untouched.

**Tech Stack:** TypeScript (strict), vitest.

## Global Constraints

- All code, comments, identifiers in English.
- The mention token grammar must stay identical to `completion.ts` `fileSuggestions`: `/(^|\s)@([\w./-]*)$/` for live suggestions; extraction uses the global form `/(^|\s)@([\w./-]+)/g`.
- Warnings never block submission.
- No content embedding anywhere.
- After all tasks: `npm run lint && npm run build && npm test`.

---

### Task 1: Mentions module

**Files:**
- Create: `src/commands/mentions.ts`
- Test: `tests/mentions.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `extractMentions(text: string): string[]`
  - `missingMentions(text: string, cwd: string): string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/mentions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMentions, missingMentions } from "../src/commands/mentions.js";

describe("extractMentions", () => {
  it("finds tokens at line start or after whitespace", () => {
    expect(extractMentions("@a.ts fix @b/c d.ts")).toEqual(["a.ts", "b/c.d.ts"]);
    expect(extractMentions("see\n@x.ts")).toEqual(["x.ts"]);
  });

  it("ignores emails and mid-word @", () => {
    expect(extractMentions("mail a@b.com please")).toEqual([]);
    expect(extractMentions("word@notamention")).toEqual([]);
  });

  it("deduplicates repeated paths", () => {
    expect(extractMentions("@a.ts then @a.ts again")).toEqual(["a.ts"]);
  });

  it("returns empty for no mentions", () => {
    expect(extractMentions("plain text /command")).toEqual([]);
  });
});

describe("missingMentions", () => {
  it("lists only paths that do not exist under cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentions-"));
    writeFileSync(join(cwd, "exists.ts"), "");
    mkdirSync(join(cwd, "dir"));
    const out = missingMentions("@exists.ts @nope.ts @dir", cwd);
    expect(out).toEqual(["nope.ts"]);
  });

  it("returns empty when everything exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentions-"));
    writeFileSync(join(cwd, "f.ts"), "");
    expect(missingMentions("@f.ts", cwd)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mentions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/commands/mentions.ts`:

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Same token grammar as completion.ts's fileSuggestions, in global form:
// "@" at line start or after whitespace, followed by path characters.
const MENTION = /(^|\s)@([\w./-]+)/g;

export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION)) found.add(m[2]);
  return [...found];
}

export function missingMentions(text: string, cwd: string): string[] {
  return extractMentions(text).filter(p => !existsSync(resolve(cwd, p)));
}
```

Note: `"b/c.d.ts"` in the first test comes from `@b/c.d.ts` — write the test
input exactly as ``"@a.ts fix @b/c.d.ts"`` so `[\w./-]+` captures the full
token.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mentions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/mentions.ts tests/mentions.test.ts
git commit -m "feat(commands): extract and validate @path mentions"
```

---

### Task 2: System prompt convention

**Files:**
- Modify: `src/engine/systemPrompt.ts:10-12` (BASE constant)
- Test: extend `tests/engine-system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the BASE prompt ends with the mention convention sentence.

- [ ] **Step 1: Write the failing test**

Add inside the main describe of `tests/engine-system-prompt.test.ts`
(matching however existing tests call `buildSystemPrompt`, e.g. with a temp
cwd):

```ts
it("documents the @path mention convention", () => {
  const prompt = buildSystemPrompt("/tmp");
  expect(prompt).toContain(
    "@path tokens referencing project-relative files"
  );
});
```

Run: `npx vitest run tests/engine-system-prompt.test.ts`
Expected: FAIL — the sentence is not in the prompt yet.

- [ ] **Step 2: Implement**

In `src/engine/systemPrompt.ts`, extend `BASE`:

```ts
const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. User messages may
contain @path tokens referencing project-relative files. Read them with the
Read tool before acting on claims about their contents. Working directory: `;
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/engine-system-prompt.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/engine/systemPrompt.ts tests/engine-system-prompt.test.ts
git commit -m "feat(engine): document the @path mention convention in the system prompt"
```

---

### Task 3: Warn on missing mentions at submit

**Files:**
- Modify: `src/ui/nativeApp.ts` — `sendUserMessage` (~line 388)
- Test: extend `tests/app.test.ts`

**Interfaces:**
- Consumes: `missingMentions(text, cwd)` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `tests/app.test.ts` (reuse its `makeApp` helper):

```ts
it("warns on a nonexistent @path but still sends the message", async () => {
  const { app, terminal } = makeApp([textTurn("ok")]);
  void app.run();
  app.submitForTest("look at @definitely-missing-file.ts");
  await wait();
  const all = terminal.writes.join("");
  expect(all).toContain("does not exist");
  expect(all).toContain("> look at @definitely-missing-file.ts");
});
```

Run: `npx vitest run tests/app.test.ts -t "nonexistent"`
Expected: FAIL — no warning appears.

- [ ] **Step 2: Implement**

In `src/ui/nativeApp.ts`, add the import:

```ts
import { missingMentions } from "../commands/mentions.js";
```

and change `sendUserMessage` to validate before appending:

```ts
  private sendUserMessage(text: string): void {
    if (!this.firstMessage) {
      this.firstMessage = text;
      if (this.session?.sessionId) this.recordSession(this.session.sessionId, this.providerName);
    }
    for (const path of missingMentions(text, this.props.cwd)) {
      this.notice(`Note: ${path} does not exist (yet)`);
    }
    this.buffer.append({ kind: "user", text });
```

(the rest of the method is unchanged).

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/app.test.ts tests/app-queue.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/nativeApp.ts tests/app.test.ts
git commit -m "feat(ui): warn on nonexistent @path mentions before sending"
```

---

### Task 4: Full gates

- [ ] Run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
```

Expected: all clean (the two pre-existing warnings in
`tests/lsp/autoInject.test.ts` are out of scope).
