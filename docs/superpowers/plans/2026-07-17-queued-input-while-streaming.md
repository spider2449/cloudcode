# Queued Input While Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user keep typing while the agent is streaming and queue Enter-submitted messages, which auto-send in FIFO order (one per turn) when the agent goes idle — matching Claude Code.

**Architecture:** Three small changes to the native TUI: (1) `InputBox` stops dropping keys when the app is streaming — its `disabled` flag becomes a `streaming` flag that only controls the hint row; (2) the `App` gains a `queuedMessages: string[]` that `handleSubmit` pushes to while streaming, rendered as muted rows above the input divider via a new `BottomState.queuedRows`; (3) the `result` branch of `handleMessage` dequeues one message through the normal submit path when the turn ends.

**Tech Stack:** TypeScript, Node, vitest. Spec: `docs/superpowers/specs/2026-07-17-queued-input-while-streaming-design.md`.

## Global Constraints

- All code comments must be in English (user's global CLAUDE.md rule).
- Never emit over-width rows: legacy conhost ignores DECAWM ?7l, so every queued-message row must be truncated to the terminal width with `truncateToWidth`.
- Run tests with `npx vitest run <file>`; full suite is `npm test`.

---

### Task 1: InputBox stays live while streaming

**Files:**
- Modify: `src/ui/widgets/inputBox.ts:74-151`
- Modify: `src/ui/nativeApp.ts:536-541, 556`
- Test: `tests/inputBox.test.ts` (and `tests/inputBox-width.test.ts` call sites)

**Interfaces:**
- Produces: `InputBox.handleKey(k: Key): void` (disabled param removed), `InputBox.handlePaste(text: string): void` (disabled param removed), `InputBox.render(theme: Theme, width: number, streaming: boolean): InputBoxRender` — `streaming` ONLY controls the hint row; cursor, suggestions, and menu are always active.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

Append to `tests/inputBox.test.ts` (inside the existing `describe("InputBox", ...)`):

```ts
  it("typing while streaming still edits the value, and render shows the hint row", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "hi");
    const r = box.render(theme, 80, true);
    expect(r.contentRows.join("\n")).toContain("> hi");
    expect(r.contentRows.join("\n")).toContain("█");
    expect(r.hintRow).toBe("working… (Esc to interrupt)");
  });

  it("paste while streaming inserts text", () => {
    const box = new InputBox(ctx(), new History());
    box.handlePaste("pasted");
    expect(box.render(theme, 80, true).contentRows.join("\n")).toContain("pasted");
  });
```

Also in this step, update every existing call site in `tests/inputBox.test.ts` and `tests/inputBox-width.test.ts`: `handleKey({...}, false)` → `handleKey({...})`, `handlePaste(text, false)` → `handlePaste(text)`. The `type()` helper in each file changes to `box.handleKey({ t: "printable", ch })`. `render(theme, N, false)` stays as-is (third arg now means `streaming`). If any existing test asserts that keys/paste are DROPPED when the second arg is `true` (search for `, true)` in those two files), delete that test — the behavior is intentionally removed per the spec.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/inputBox.test.ts`
Expected: FAIL — compile errors (`handleKey` expects 2 args) and/or the new tests failing.

- [ ] **Step 3: Implement**

In `src/ui/widgets/inputBox.ts`:

```ts
  handleKey(k: Key): void {
    if (k.t === "ctrl" || k.t === "alt") return;
    // ... rest of the method body unchanged (delete only the `if (disabled) return;` line and the parameter)
```

```ts
  handlePaste(text: string): void {
    // Pasted newlines are literal text, never Enter: submitting mid-paste
    // would fire the first line at the model. Normalize CRLF/CR to LF and
    // strip other control characters.
    const clean = [...text.replace(/\r\n?/g, "\n")].filter(ch => ch === "\n" || ch >= " ").join("");
    this.setValue(this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor), this.cursor + clean.length);
  }
```

```ts
  render(theme: Theme, width: number, streaming: boolean): InputBoxRender {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const content = "> " + before + "█" + after;
    const innerWidth = Math.max(1, width - 4);
    const wrapped = this.wrap(content, innerWidth);
    // A single muted divider separating the transcript from the input area.
    const dividerCode = sgr(theme.muted);
    const divider = "─".repeat(Math.max(1, width));
    const borderRows = [dividerCode ? `${dividerCode}${divider}${SGR_RESET}` : divider];
    const hintRow = streaming ? "working… (Esc to interrupt)" : null;
    const suggestions = this.currentSuggestions();
    const menuRows = renderMenu(suggestions, Math.min(this.selected, Math.max(0, suggestions.length - 1)), theme, width);
    return {
      borderRows,
      contentRows: wrapped,
      menuRows,
      hintRow,
      totalRows: borderRows.length + wrapped.length + (hintRow ? 1 : 0) + menuRows.length
    };
  }
```

In `src/ui/nativeApp.ts` update the three call sites:

```ts
    if (k.t === "paste") {
      this.inputBox.handlePaste(k.text);
      this.recompute();
      return;
    }
    this.inputBox.handleKey(k);
    this.recompute();
```

The `render` call in `recompute()` (line ~556) is unchanged textually — `this.inputBox.render(this.theme, size.columns, this.phase === "streaming")` — the third argument's meaning is now "streaming" (hint row only).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inputBox.test.ts tests/inputBox-width.test.ts tests/app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/inputBox.ts src/ui/nativeApp.ts tests/inputBox.test.ts tests/inputBox-width.test.ts
git commit -m "feat(ui): keep input box live while the agent is streaming"
```

---

### Task 2: Render queued messages above the input box

**Files:**
- Modify: `src/ui/term/render.ts:28-40, 76-83`
- Modify: `src/ui/nativeApp.ts` (field + `recompute()` + imports)
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: `BottomState.queuedRows: string[]` (required field; pre-truncated, pre-colored rows placed directly above the input divider); `App` private field `queuedMessages: string[]` that `recompute()` renders from. Task 3 pushes to / shifts from `queuedMessages`.

- [ ] **Step 1: Write the failing test**

`tests/render.test.ts` builds all its `BottomState` values through a `baseBottom(overrides)` helper (line ~13). First add `queuedRows: [],` to `baseBottom`'s returned defaults (before the `...overrides` spread) so every existing test compiles once the field becomes required. Then add inside the existing `describe("InlineRenderer", ...)`:

```ts
  it("renders queuedRows above the input box rows", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    const out = r.frame(
      buf,
      baseBottom({ queuedRows: ["⧉ queued: fix tests"] }),
      theme,
      size
    );
    expect(out).toContain("⧉ queued: fix tests");
    // Queued rows sit above the input box's first border row ("╭─╮" in
    // emptyInputRender), i.e. earlier in the footer paint.
    expect(out.indexOf("⧉ queued: fix tests")).toBeLessThan(out.indexOf("╭─╮"));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — `queuedRows` unknown property / assertion failure.

- [ ] **Step 3: Implement**

In `src/ui/term/render.ts`, add the field to `BottomState`:

```ts
export interface BottomState {
  overlay: OverlayMode;
  streaming: boolean;
  streamingText: string;
  thinkingText: string;
  activeTool?: string;
  compactPct?: number;
  // Muted, width-truncated rows for messages queued while streaming; drawn
  // directly above the input divider.
  queuedRows: string[];
  inputRender: InputBoxRender;
  overlayRows: string[];
  statusBarProps: StatusBarProps;
  workIndFrame: number;
  workStartedAt: number;
}
```

In `frame()`, place them above the input box (after the border unshift, inside the `else` branch so overlays hide them):

```ts
    } else {
      dyn.unshift(...bottom.inputRender.menuRows);
      if (bottom.inputRender.hintRow !== null) dyn.unshift(bottom.inputRender.hintRow);
      dyn.unshift(...bottom.inputRender.contentRows);
      dyn.unshift(...bottom.inputRender.borderRows);
      dyn.unshift(...bottom.queuedRows);
    }
```

In `src/ui/nativeApp.ts`:

Extend the ansi import and add a width import:

```ts
import { CLEAR_AND_HOME, CLEAR_ALL_AND_HOME, sgr, SGR_RESET } from "./term/ansi.js";
import { truncateToWidth } from "./width.js";
```

Add the field next to the other private state (near `private permissionQueue`):

```ts
  // Messages submitted while a turn was in flight; sent FIFO, one per turn,
  // when the agent returns to idle.
  private queuedMessages: string[] = [];
```

In `recompute()`, build the rows and pass them (newlines flattened so one queued message is one row; truncated because conhost ignores autowrap-off):

```ts
    const queueCode = sgr(this.theme.muted);
    const queuedRows = this.queuedMessages.map(m => {
      const row = truncateToWidth(`⧉ queued: ${m.replace(/\n/g, " ")}`, Math.max(1, size.columns));
      return queueCode ? `${queueCode}${row}${SGR_RESET}` : row;
    });
    const bottom: BottomState = {
      overlay: this.overlay.mode,
      streaming: this.phase === "streaming",
      streamingText: this.streamText,
      thinkingText: this.thinkingText,
      activeTool: this.activeTool,
      compactPct: this.compactPct,
      queuedRows,
      // ... rest unchanged
```

Note: `src/ui/width.ts` already exports `truncateToWidth` (used by `layout.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/render.test.ts tests/app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/term/render.ts src/ui/nativeApp.ts tests/render.test.ts
git commit -m "feat(ui): render queued messages above the input divider"
```

---

### Task 3: Queue on submit while streaming, drain on idle

**Files:**
- Modify: `src/ui/nativeApp.ts:192-213 (handleMessage result branch), 419-435 (handleSubmit)`
- Test: `tests/app-queue.test.ts` (create)

**Interfaces:**
- Consumes: `queuedMessages: string[]` and its `queuedRows` rendering from Task 2; live-while-streaming input from Task 1.
- Produces: end-user behavior only; no new exports.

- [ ] **Step 1: Write the failing tests**

Create `tests/app-queue.test.ts`. It reuses the mock header and helpers from `tests/app.test.ts`, plus a gated client whose turn does not finish until the test releases it:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../src/ui/nativeApp.js";
import { FakeTerminal } from "../src/ui/term/terminal.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

vi.mock("../src/agent/models.js", () => ({
  fetchModels: vi.fn().mockResolvedValue(["model-a", "model-b"])
}));
vi.mock("../src/engine/api.js", () => ({ makeClient: vi.fn() }));
vi.mock("../src/agent/mcp.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/mcp.js")>("../src/agent/mcp.js");
  // Keep tests hermetic: never read the developer's real ~/.cloudcode/mcp.json.
  return { ...actual, loadMcpServers: vi.fn().mockReturnValue({}) };
});

import { makeClient } from "../src/engine/api.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

// A client whose first turn stalls mid-stream until release() is called, so
// tests can submit input while the app is verifiably in the streaming phase.
// Later turns pass through the already-resolved gate immediately.
function gatedClient() {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const client = {
    create: vi.fn(async function* () {
      yield { type: "content_block_start", content_block: { type: "text" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "working" } };
      await gate;
      yield { type: "content_block_stop" };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
    })
  };
  return { client, release: () => release() };
}

beforeEach(() => {
  vi.mocked(makeClient).mockReset();
});

function makeApp() {
  const { client, release } = gatedClient();
  vi.mocked(makeClient).mockReturnValue(client as never);
  const terminal = new FakeTerminal({ rows: 24, columns: 80 });
  const app = new App({
    cwd: "/repo",
    providers: { anthropic: {} },
    initialProvider: "anthropic",
    sessionIndex: new SessionIndex()
  }, terminal);
  return { app, terminal, release, client };
}

describe("App input queue", () => {
  it("queues a message submitted while streaming and shows a queued row", async () => {
    const { app, terminal } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.submitForTest("second");
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("queued: second");
    // Not yet sent as a user message.
    expect(terminal.writes.join("")).not.toContain("> second");
  });

  it("drains queued messages FIFO when the turn completes", async () => {
    const { app, terminal, release, client } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.submitForTest("second");
    app.submitForTest("third");
    await wait();
    release();
    await wait(80);
    const all = terminal.writes.join("");
    expect(all).toContain("> second");
    expect(all).toContain("> third");
    expect(all.indexOf("> second")).toBeLessThan(all.indexOf("> third"));
    // One send per message: first + second + third.
    expect(client.create).toHaveBeenCalledTimes(3);
  });

  it("typing while streaming updates the input box", async () => {
    const { app, terminal } = makeApp();
    void app.run();
    app.submitForTest("first");
    await wait();
    app.handleKey({ t: "printable", ch: "z" });
    await wait();
    const last = terminal.writes[terminal.writes.length - 1];
    expect(last).toContain("> z█");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/app-queue.test.ts`
Expected: the first two tests FAIL (submit while streaming is currently dropped, so no "queued:" row and nothing drains). The third may already pass after Task 1 — that is fine.

- [ ] **Step 3: Implement**

In `src/ui/nativeApp.ts`, change `handleSubmit`'s early return into a queue push:

```ts
  private handleSubmit(text: string): void {
    if (this.phase === "streaming") {
      // The agent is mid-turn: queue the message and send it when idle.
      // Slash parsing happens at dequeue time so queued commands run in order.
      this.queuedMessages.push(text);
      this.recompute();
      return;
    }
    const slash = parseSlash(text);
    // ... rest unchanged
```

In `handleMessage`, drain one message at the end of the `result` branch (after `this.turnCount += 1;`):

```ts
      this.turnCount += 1;
      void this.git.refresh().then(() => this.recompute());
      const next = this.queuedMessages.shift();
      if (next !== undefined) this.handleSubmit(next);
```

Sending the next message flips `phase` back to `"streaming"`, so the remaining queue drains one message per completed turn. Errors and interrupts that produce a `result` message drain through the same path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app-queue.test.ts`
Expected: PASS (all 3)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/ui/nativeApp.ts tests/app-queue.test.ts
git commit -m "feat(ui): queue messages submitted while streaming and auto-send on idle"
```
