# Compact/Session-File Persistence Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/compact` (and auto-compact) persist the compacted history to the session's JSONL file, so resuming a compacted session loads the summary instead of the stale pre-compact transcript.

**Architecture:** `AgentSession.compact()` currently replaces the in-memory `EngineLoop.messages` with a one-message summary but never touches the append-only `SessionFile`. Fix: add a `rewrite(entries)` method to `SessionFile` that replaces the file's contents, call it from `AgentSession.compact()` right after the in-memory compaction succeeds, and reset the memory-extraction cursor to the new (shorter) history length. Both the `/compact` command and the auto-compact path go through `AgentSession.compact()`, so one fix covers both.

**Tech Stack:** TypeScript (ESM, Node >= 18), vitest.

## Global Constraints

- ALL code, comments, and test names in English only (user global CLAUDE.md).
- ESM project: relative imports use the `.js` suffix even in `.ts` files (e.g. `from "./sessions.js"`).
- Run tests with `npx vitest run <file>`; full suite must stay green (577 tests currently pass).
- Commit messages follow conventional-commit style (`fix:`, `test:`, ...) and end with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## The Bug (context for the implementer)

1. `src/engine/sessions.ts` — `SessionFile` is append-only. `AgentSession.send()` (`src/agent/session.ts:97`) appends only the messages added during that turn (`messages.slice(before)`).
2. `src/agent/session.ts:162` — `compact()` calls `this.loop.compact(...)`, which replaces `loop.messages` with `[{ role: "user", content: "Summary of prior conversation: ..." }]` (see `src/engine/compact.ts:50`). The JSONL file is left untouched, still holding the full pre-compact history — and the summary message itself is never written anywhere.
3. Next `send()` after compact computes `before = 1` and appends `slice(1)` (the new turn) to the JSONL. Resulting file = full old history + new turn, **missing the summary**. Resuming that session (`SessionFile.load` in `start()`) restores the pre-compact history, silently undoing the compaction.
4. Bonus inconsistency: `extractCursor` (`src/agent/session.ts:56`) still points at the old, longer history after compact. It self-heals (slicing past the end yields `[]`) but should be reset for correctness.

---

### Task 1: `SessionFile.rewrite()`

**Files:**
- Modify: `src/engine/sessions.ts`
- Test: `tests/engine-sessions.test.ts`

**Interfaces:**
- Consumes: existing `SessionFile` class (`constructor(sessionId, dir?)`, `append(entry)`, `static load(sessionId, dir?)`).
- Produces: `rewrite(entries: unknown[]): void` — replaces the entire file contents with one JSON line per entry; an empty array produces an empty file. Task 2 calls this from `AgentSession.compact()`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("SessionFile", ...)` block in `tests/engine-sessions.test.ts`:

```ts
  it("rewrite() replaces all previously appended entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess3-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old 1" });
    s.append({ role: "assistant", content: [{ type: "text", text: "old 2" }] });
    s.rewrite([{ role: "user", content: "Summary of prior conversation: condensed" }]);
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "Summary of prior conversation: condensed" }
    ]);
  });

  it("append() after rewrite() extends the rewritten history", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess4-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old" });
    s.rewrite([{ role: "user", content: "summary" }]);
    s.append({ role: "assistant", content: [{ type: "text", text: "new" }] });
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "summary" },
      { role: "assistant", content: [{ type: "text", text: "new" }] }
    ]);
  });

  it("rewrite([]) leaves an empty, loadable session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess5-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old" });
    s.rewrite([]);
    expect(SessionFile.load("abc", dir)).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-sessions.test.ts`
Expected: 3 new tests FAIL with `s.rewrite is not a function`.

- [ ] **Step 3: Implement `rewrite()`**

In `src/engine/sessions.ts`, change the fs import and add the method:

```ts
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
```

Inside the `SessionFile` class, after `append()`:

```ts
  // Replaces the whole file — used after /compact so a resumed session
  // loads the compacted history instead of the stale pre-compact transcript.
  rewrite(entries: unknown[]): void {
    writeFileSync(this.filePath, entries.map(e => JSON.stringify(e) + "\n").join(""));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-sessions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/sessions.ts tests/engine-sessions.test.ts
git commit -m "feat(sessions): add SessionFile.rewrite for post-compact persistence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Persist compaction in `AgentSession.compact()`

**Files:**
- Modify: `src/agent/session.ts:162-165` (the `compact()` method)
- Test: `tests/session-integration.test.ts`

**Interfaces:**
- Consumes: `SessionFile.rewrite(entries: unknown[]): void` from Task 1; existing `EngineLoop.compact(client, model, onProgress?)` which mutates `loop.messages` and returns an estimated token count; private fields `this.sessionFile`, `this.loop`, `this.extractCursor`.
- Produces: no signature change — `compact(onProgress?): Promise<number | undefined>` now also rewrites the session file and resets `extractCursor`.

- [ ] **Step 1: Write the failing integration test**

Append inside `describe("AgentSession integration", ...)` in `tests/session-integration.test.ts` (the file's existing `fakeClient`/`textTurn` helpers and the temp-HOME `beforeEach`/`afterEach` already apply). Note the shared `fakeClient` call counter serves turns in order: turn 1 = the chat reply, turn 2 = the compaction summary, turn 3 = the post-compact reply.

```ts
  it("compact() persists the summarized history so resume loads the summary, not the stale transcript", async () => {
    vi.mocked(makeClient).mockReturnValue(fakeClient([
      textTurn("hello there"),
      textTurn("CONDENSED SUMMARY"),
      textTurn("after compact reply")
    ]));
    const messages: unknown[] = [];
    let sessionId = "";
    const session = new AgentSession({
      providerName: "anthropic",
      provider: {},
      permissionMode: "default",
      cwd: "/p",
      onMessage: m => messages.push(m),
      onPermissionRequest: () => {},
      onSessionId: id => { sessionId = id; }
    });
    session.start();
    session.send("hello");
    await vi.waitFor(() => expect(messages.some(m => (m as { type: string }).type === "result")).toBe(true));

    await session.compact();

    // The file now holds exactly the compacted history: one summary message.
    const afterCompact = SessionFile.load(sessionId);
    expect(afterCompact).toHaveLength(1);
    expect(JSON.stringify(afterCompact)).toContain("CONDENSED SUMMARY");
    expect(JSON.stringify(afterCompact)).not.toContain("hello there");

    // The extraction cursor tracks the new, shorter history.
    expect((session as unknown as { extractCursor: number }).extractCursor).toBe(1);

    // A follow-up turn appends after the summary without resurrecting old history.
    session.send("next question");
    await vi.waitFor(() => {
      const all = SessionFile.load(sessionId);
      return expect(JSON.stringify(all)).toContain("after compact reply");
    });
    const finalFile = SessionFile.load(sessionId);
    const flat = JSON.stringify(finalFile);
    expect(flat).toContain("CONDENSED SUMMARY");
    expect(flat).toContain("next question");
    expect(flat).not.toContain("hello there");
    await session.dispose();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-integration.test.ts`
Expected: the new test FAILS on `expect(afterCompact).toHaveLength(1)` — the file still contains the pre-compact turn (2+ entries) and no summary.

- [ ] **Step 3: Implement the fix**

In `src/agent/session.ts`, replace the `compact()` method (currently lines 162-165):

```ts
  async compact(onProgress?: (pct: number) => void): Promise<number | undefined> {
    if (!this.loop) return undefined;
    const estimatedTokens = await this.loop.compact(
      makeClient(this.opts.provider),
      this.opts.model ?? this.opts.provider.model ?? DEFAULT_MODEL,
      onProgress
    );
    // The session file is append-only during normal turns; compaction is the
    // one place history shrinks, so rewrite the file to match loop.messages
    // or a later resume would reload the stale pre-compact transcript.
    this.sessionFile?.rewrite(this.loop.messages);
    // Old cursor positions point into the discarded history; realign so the
    // next extraction window starts at the compacted state.
    this.extractCursor = this.loop.messages.length;
    return estimatedTokens;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all test files pass (577 existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/agent/session.ts tests/session-integration.test.ts
git commit -m "fix(session): persist compacted history to the session file

/compact and auto-compact replaced the in-memory history with a summary
but left the JSONL session file untouched, so resuming a compacted
session reloaded the full pre-compact transcript and dropped the
summary. Rewrite the file from loop.messages after compaction and
realign the memory-extraction cursor.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Coverage:** Both halves of the reported bug are addressed — file divergence (Task 2 rewrite) and cursor drift (Task 2 reset). Both `/compact` (via `ctx.compact` → `App` → `AgentSession.compact`) and auto-compact (`App.runAutoCompact` → `AgentSession.compact`) route through the fixed method; no other caller mutates history destructively.
- **Placeholders:** None — every step carries complete code and exact commands.
- **Type consistency:** `rewrite(entries: unknown[]): void` matches its call site `this.sessionFile?.rewrite(this.loop.messages)` (`messages: unknown[]` on `EngineLoop`). `compact()`'s public signature is unchanged, so `App` and the `/compact` command need no edits.
