# Configurable Status Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick which segments appear in the bottom status line via a `/statusline` picker overlay, persisted to settings and applied live.

**Architecture:** A shared item-ID registry module (no imports, usable from both `agent/` and `ui/`) defines the canonical segment list and default set. Settings gains a validated `statusLineItems: string[]` field; `renderStatusBar` filters/renders segments by ID; a new overlay mode toggles items; `/statusline` opens it and each toggle persists + recomputes immediately.

**Tech Stack:** TypeScript (strict), vitest, hand-rolled ANSI terminal UI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-statusline-config-design.md`

## Global Constraints

- All code/comments in English only.
- `tsconfig.json` stays `"strict": true`; no `any`, no non-null `!` assertions.
- No file in `src/` or `tests/` past ~600 lines (`npm run lint:size`).
- Tests land in the same commit as the feature (AGENTS.md testing convention).
- Error handling only at existing boundaries; config loaders fall back to defaults on bad input.
- Run tests with `npm test` (vitest run); typecheck with `npm run build`; lint with `npm run lint`.

---

### Task 1: Item registry module

**Files:**
- Create: `src/statusLineItems.ts`
- Test: `tests/statusLineItems.test.ts`

**Interfaces:**
- Consumes: nothing (no imports — this module must be safe for both `agent/` and `ui/` layers).
- Produces (used by Tasks 2–6):
  - `STATUS_LINE_ITEMS: readonly ["model", "servedModel", "effort", "mode", "network", "branch", "tokens", "cost", "elapsed", "cwd"]`
  - `type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number]`
  - `DEFAULT_STATUS_LINE_ITEMS: StatusLineItem[]` = `["model", "mode", "branch", "tokens"]`
  - `STATUS_LINE_LABELS: Record<StatusLineItem, string>`
  - `normalizeStatusLineItems(value: unknown): StatusLineItem[] | undefined` — returns deduped known-ID list preserving order for valid string arrays (including empty), `undefined` for anything else
  - `canonicalOrder(enabled: Set<StatusLineItem>): StatusLineItem[]`

- [ ] **Step 1: Write the failing test**

Create `tests/statusLineItems.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  STATUS_LINE_ITEMS,
  DEFAULT_STATUS_LINE_ITEMS,
  STATUS_LINE_LABELS,
  normalizeStatusLineItems,
  canonicalOrder,
} from "../src/statusLineItems.js";

describe("status line item registry", () => {
  it("exposes labels for every registered item", () => {
    for (const item of STATUS_LINE_ITEMS) expect(STATUS_LINE_LABELS[item]).toBeTruthy();
  });

  it("defaults to model/mode/branch/tokens", () => {
    expect(DEFAULT_STATUS_LINE_ITEMS).toEqual(["model", "mode", "branch", "tokens"]);
  });
});

describe("normalizeStatusLineItems", () => {
  it("returns undefined for non-arrays", () => {
    expect(normalizeStatusLineItems("model")).toBeUndefined();
    expect(normalizeStatusLineItems({})).toBeUndefined();
    expect(normalizeStatusLineItems(undefined)).toBeUndefined();
  });

  it("keeps known IDs in user order and drops unknown ones", () => {
    expect(normalizeStatusLineItems(["cost", "bogus", "mode"])).toEqual(["cost", "mode"]);
  });

  it("removes duplicates while keeping first occurrence order", () => {
    expect(normalizeStatusLineItems(["cwd", "cost", "cwd"])).toEqual(["cwd", "cost"]);
  });

  it("treats an empty array as a valid explicit-empty choice", () => {
    expect(normalizeStatusLineItems([])).toEqual([]);
  });
});

describe("canonicalOrder", () => {
  it("lists enabled items in registry order regardless of insertion order", () => {
    expect(canonicalOrder(new Set(["cost", "model"]))).toEqual(["model", "cost"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statusLineItems.test.ts`
Expected: FAIL — cannot resolve `../src/statusLineItems.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/statusLineItems.ts`:

```ts
// Canonical segment list for the configurable status line. Deliberately
// import-free so both src/agent (settings validation) and src/ui (rendering,
// overlay) can depend on it without crossing layers.

export const STATUS_LINE_ITEMS = [
  "model",
  "servedModel",
  "effort",
  "mode",
  "network",
  "branch",
  "tokens",
  "cost",
  "elapsed",
  "cwd"
] as const;

export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

export const DEFAULT_STATUS_LINE_ITEMS: StatusLineItem[] = ["model", "mode", "branch", "tokens"];

export const STATUS_LINE_LABELS: Record<StatusLineItem, string> = {
  model: "Provider / model",
  servedModel: "Served model override",
  effort: "Reasoning effort",
  mode: "Permission mode",
  network: "Network mode",
  branch: "Git branch",
  tokens: "Token usage / context %",
  cost: "Session cost",
  elapsed: "Elapsed time",
  cwd: "Working directory"
};

const KNOWN: readonly string[] = STATUS_LINE_ITEMS;

/** Valid string arrays become a deduped known-ID list (empty allowed);
 * everything else is invalid and the caller falls back to defaults. */
export function normalizeStatusLineItems(value: unknown): StatusLineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: StatusLineItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !KNOWN.includes(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry as StatusLineItem);
  }
  return out;
}

export function canonicalOrder(enabled: Set<StatusLineItem>): StatusLineItem[] {
  return STATUS_LINE_ITEMS.filter(item => enabled.has(item));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/statusLineItems.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/statusLineItems.ts tests/statusLineItems.test.ts
git commit -m "feat: add status line item registry"
```

---

### Task 2: Persist statusLineItems in settings

**Files:**
- Modify: `src/agent/settings.ts`
- Test: `tests/settings.test.ts` (add cases)

**Interfaces:**
- Consumes: `normalizeStatusLineItems`, `StatusLineItem` from `src/statusLineItems.ts` (Task 1).
- Produces:
  - `Settings.statusLineItems?: string[]`
  - `saveSetting(key, value, filePath?)` value parameter widened to `string | boolean | string[]`

- [ ] **Step 1: Write the failing tests**

Add inside the existing top-level `describe` (or as a new sibling `describe("statusLineItems setting")`) in `tests/settings.test.ts`, reusing that file's existing temp-dir helper style:

```ts
import { loadSettings, saveSetting } from "../src/agent/settings.js";

describe("statusLineItems setting", () => {
  it("round-trips an array through save/load", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
    saveSetting("statusLineItems", ["cost", "mode"], file);
    expect(loadSettings(file).statusLineItems).toEqual(["cost", "mode"]);
  });

  it("drops unknown IDs and duplicates on load", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
    saveSetting("statusLineItems", ["nope" as string, "cost", "cost"], file);
    expect(loadSettings(file).statusLineItems).toEqual(["cost"]);
  });

  it("ignores non-array values and preserves an explicit empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-settings-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ statusLineItems: "model" }));
    expect(loadSettings(bad).statusLineItems).toBeUndefined();
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ statusLineItems: [] }));
    expect(loadSettings(empty).statusLineItems).toEqual([]);
  });

  it("preserves unknown sibling keys when saving the array", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
    saveSetting("customFutureKey" as keyof never, "keep-me", file);
    saveSetting("statusLineItems", ["cost"], file);
    expect(loadSettings(file).statusLineItems).toEqual(["cost"]);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["customFutureKey"]).toBe("keep-me");
  });
});
```

Adjust imports at the top of the test file to match what it already imports (`join`, `tmpdir`, `mkdtempSync` likely present; add `writeFileSync`, `readFileSync` from `node:fs` if missing). If the existing helper differs, follow its pattern — the assertions above are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — TypeScript rejects `"statusLineItems"` as a key / value type.

- [ ] **Step 3: Implement**

In `src/agent/settings.ts`:

Add import:

```ts
import { normalizeStatusLineItems } from "../statusLineItems.js";
```

Extend the interface (after `networkMode?: PersistedNetworkMode;`):

```ts
  /** Segment IDs shown in the bottom status bar; absent means app default. */
  statusLineItems?: string[];
```

Add to `loadSettings` before `return out;`:

```ts
  const statusLineItems = normalizeStatusLineItems(raw.statusLineItems);
  if (statusLineItems) out.statusLineItems = statusLineItems;
```

Widen `saveSetting`'s signature:

```ts
export function saveSetting(key: keyof Settings, value: string | boolean | string[], filePath: string = DEFAULT_FILE()): void {
```

(body unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/agent/settings.ts tests/settings.test.ts
git commit -m "feat: persist statusLineItems in settings"
```

---

### Task 3: renderStatusBar honors an item list

**Files:**
- Modify: `src/ui/widgets/statusBar.ts`
- Test: `tests/widgets.test.ts` (update existing cases + add new describe block)

**Interfaces:**
- Consumes: `StatusLineItem`, `DEFAULT_STATUS_LINE_ITEMS`, `STATUS_LINE_ITEMS` from `src/statusLineItems.ts` (Task 1).
- Produces:
  - `StatusBarProps.items?: StatusLineItem[]` — segments rendered = this list filtered by availability, in list order; absent → `DEFAULT_STATUS_LINE_ITEMS`.
  - Behavior note: `servedModel` renders as part of the `model` segment (the `→served` arrow appears only when `servedModel` is enabled); its own builder returns null so no standalone segment exists. This keeps output byte-compatible with today's fixed sequence for equivalent enabled sets.

- [ ] **Step 1: Update the failing tests**

In `tests/widgets.test.ts`, add to the imports:

```ts
import { STATUS_LINE_ITEMS, DEFAULT_STATUS_LINE_ITEMS } from "../src/statusLineItems.js";
import type { StatusLineItem } from "../src/statusLineItems.js";
```

Add a helper just below `const theme = THEMES.dark;`:

```ts
const ALL: StatusLineItem[] = [...STATUS_LINE_ITEMS];
```

Update existing `renderStatusBar` cases to pin old behavior by passing `items: ALL` (add the property to each props object literal):
- "joins segments with the middle dot..." → `{ provider: "anthropic", model: "sonnet", mode: "default", cwd: "/repo", items: ALL }`
- "shows served-model arrow..." → same props + `servedModel: "sonnet-5"`, `items: ALL`
- "always shows the effort segment..." → both literals get `items: ALL`
- "places the effort segment immediately after provider/model" → `items: ALL`
- "includes git branch with a dirty marker..." → `items: ALL`
- "omits token/cost/elapsed segments..." → `items: ALL`
- "stays on one row...", "wraps at segment boundaries...", "truncates a single segment..." → `items: ALL`

Then append a new describe block after the existing `renderStatusBar` describe:

```ts
describe("renderStatusBar item selection", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("uses the curated default set when items is absent", () => {
    const text = stripAnsi(renderStatusBar(
      { provider: "anthropic", model: "sonnet", mode: "default", cwd: "/repo", costUsd: 1 },
      theme, 120
    ).join("\n"));
    expect(text).toContain("anthropic/sonnet");
    expect(text).toContain("default");
    expect(text).not.toContain("/repo");
    expect(text).not.toContain("$");
    // Registry order is respected even though props listed cost first is impossible here;
    // verify default equals the registry-filtered default set.
    expect(DEFAULT_STATUS_LINE_ITEMS).toEqual(["model", "mode", "branch", "tokens"]);
  });

  it("renders exactly the requested segments in the given order", () => {
    const text = stripAnsi(renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", gitBranch: "main", costUsd: 0.5, items: ["cost", "branch"] },
      theme, 120
    ).join("\n"));
    expect(text.indexOf("$0.5000")).toBeLessThan(text.indexOf("⎇ main"));
    expect(text).not.toContain("default");
    expect(text).not.toContain("/r");
  });

  it("suppresses the served-model arrow unless servedModel is enabled", () => {
    const without = stripAnsi(renderStatusBar(
      { provider: "anthropic", model: "sonnet", servedModel: "sonnet-5", mode: "default", cwd: "/r", items: ["model", "mode"] },
      theme, 120
    ).join("\n"));
    expect(without).toContain("anthropic/sonnet");
    expect(without).not.toContain("→");
    const withServed = stripAnsi(renderStatusBar(
      { provider: "anthropic", model: "sonnet", servedModel: "sonnet-5", mode: "default", cwd: "/r", items: ["model", "servedModel", "mode"] },
      theme, 120
    ).join("\n"));
    expect(withServed).toContain("sonnet→sonnet-5");
  });

  it("skips null-yielding segments without leaving stray separators", () => {
    const rows = renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", items: ["branch", "tokens"] },
      theme, 80
    );
    expect(rows).toHaveLength(0);
  });

  it("renders an empty bar for an explicitly empty list", () => {
    const rows = renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", items: [] },
      theme, 80
    );
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/widgets.test.ts`
Expected: FAIL — new selection cases fail (props ignore `items`; default still shows cwd), and TS may reject unknown `items` property.

- [ ] **Step 3: Implement**

Rewrite `renderStatusBar` in `src/ui/widgets/statusBar.ts`. Keep the interfaces/formatters above it unchanged; add imports and replace the function body:

```ts
import { DEFAULT_STATUS_LINE_ITEMS, STATUS_LINE_ITEMS } from "../../statusLineItems.js";
import type { StatusLineItem } from "../../statusLineItems.js";
```

Extend `StatusBarProps` (new last field):

```ts
  /** Which segments to render, in order; omitted means the curated default. */
  items?: StatusLineItem[];
```

Replace the body of `renderStatusBar` (lines 35–49 region) with:

```ts
function segmentFor(item: StatusLineItem, p: StatusBarProps, servedEnabled: boolean): string | null {
  switch (item) {
    case "model": {
      const base = servedEnabled ? p.servedModel ?? p.model : p.model;
      const label =
        servedEnabled && p.servedModel && p.model && p.servedModel !== p.model
          ? `${p.model}→${p.servedModel}`
          : base;
      return label ? `${p.provider}/${label}` : p.provider;
    }
    case "servedModel":
      return null; // folded into the model segment via the arrow
    case "effort":
      return p.effort != null ? `effort: ${p.effort}` : null;
    case "mode":
      return p.mode;
    case "network":
      return p.networkMode ? `network: ${p.networkMode}` : null;
    case "branch":
      return p.gitBranch ? `⎇ ${p.gitBranch}${p.gitDirty ? "*" : ""}` : null;
    case "tokens":
      return p.tokens != null && p.tokens > 0
        ? formatTokens(p.tokens) + (p.contextPct != null ? ` (${p.contextPct}%)` : "")
        : null;
    case "cost":
      return p.costUsd != null && p.costUsd > 0 ? `$${p.costUsd.toFixed(4)}` : null;
    case "elapsed":
      return p.elapsedMs != null && p.elapsedMs > 0 ? formatElapsed(p.elapsedMs) : null;
    case "cwd":
      return p.cwd;
  }
}

export function renderStatusBar(p: StatusBarProps, theme: Theme, width: number): string[] {
  const requested = p.items ?? DEFAULT_STATUS_LINE_ITEMS;
  const servedEnabled = requested.includes("servedModel");
  const segments: string[] = [];
  for (const item of STATUS_LINE_ITEMS) {
    if (!requested.includes(item)) continue;
    const segment = segmentFor(item, p, servedEnabled);
    if (segment != null) segments.push(segment);
  }
  // Pack whole segments onto rows of at most `width` columns instead of
  // truncating: overflowing segments wrap onto extra rows. No emitted row may
  // ever exceed the terminal width (legacy conhost ignores DECAWM-off), so a
  // single segment wider than the whole terminal is ellipsis-truncated.
  const SEP = " · ";
  const rows: string[] = [];
  let current = "";
  for (let segment of segments) {
    if (stringWidth(segment) > width) segment = truncateToWidth(segment, width);
    if (current === "") current = segment;
    else if (stringWidth(current) + SEP.length + stringWidth(segment) <= width) current += SEP + segment;
    else { rows.push(current); current = segment; }
  }
  if (current !== "") rows.push(current);
  const code = sgr(theme.muted);
  return code ? rows.map(r => `${code}${r}${SGR_RESET}`) : rows;
}
```

Iterating `STATUS_LINE_ITEMS` (registry order) and skipping unrequested IDs guarantees deterministic ordering even if a caller passes an unordered list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/widgets.test.ts && npm run build`
Expected: PASS including all pre-existing cases pinned with `items: ALL`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/statusBar.ts tests/widgets.test.ts
git commit -m "feat: renderStatusBar renders a configurable segment list"
```

---

### Task 4: Statusline toggle overlay

**Files:**
- Modify: `src/ui/widgets/overlay.ts`
- Test: `tests/overlay.test.ts` (add cases)

**Interfaces:**
- Consumes: `STATUS_LINE_ITEMS`, `STATUS_LINE_LABELS`, `canonicalOrder`, `StatusLineItem` from `src/statusLineItems.ts` (Task 1); `visibleWindow`, `MAX_ROWS` already imported.
- Produces:
  - `OverlayMode` union gains `"statusline"`.
  - `OverlayManager.openStatusLine(current: StatusLineItem[], onToggle: (next: StatusLineItem[]) => void, onCancel: () => void): void`
  - Keys: up/down move cursor, enter/space toggle and fire `onToggle(canonicalOrder(enabled))` immediately (overlay stays open), esc closes and fires `onCancel`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/overlay.test.ts` (follow the file's existing import/style; add these imports if absent):

```ts
import { STATUS_LINE_ITEMS } from "../src/statusLineItems.js";

describe("statusline overlay", () => {
  const items = [...STATUS_LINE_ITEMS];

  it("opens, lists every item, and reports the mode", () => {
    const mgr = new OverlayManager();
    mgr.openStatusLine(items, () => {}, () => {});
    expect(mgr.mode).toBe("statusline");
    const rows = mgr.render(THEMES.dark, 80).map(strip);
    expect(rows.some(r => r.includes("Provider / model"))).toBe(true);
    expect(rows.some(r => r.includes("Working directory"))).toBe(true);
  });

  it("enter/space toggles and fires onToggle with canonical-order list", () => {
    const mgr = new OverlayManager();
    const toggles: string[][] = [];
    mgr.openStatusLine(items, next => toggles.push(next), () => {});
    mgr.handleKey({ t: "down" }); // cursor on servedModel
    mgr.handleKey({ t: "enter" }); // enable servedModel
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toContain("servedModel");
    expect(toggles[0].indexOf("model")).toBeLessThan(toggles[0].indexOf("servedModel")); // registry order
    mgr.handleKey({ t: "printable", ch: " " }); // space disables it again
    expect(toggles).toHaveLength(2);
    expect(toggles[1]).not.toContain("servedModel");
  });

  it("esc closes and fires onCancel", () => {
    const mgr = new OverlayManager();
    let cancelled = false;
    mgr.openStatusLine(items, () => {}, () => { cancelled = true; });
    mgr.handleKey({ t: "esc" });
    expect(mgr.mode).toBe("none");
    expect(cancelled).toBe(true);
  });

  it("renders checked markers for enabled items", () => {
    const mgr = new OverlayManager();
    mgr.openStatusLine(["model", "cost"], () => {}, () => {});
    const rows = mgr.render(THEMES.dark, 80).map(strip);
    expect(rows.some(r => r.includes("[x]") && r.includes("Session cost"))).toBe(true);
    expect(rows.some(r => r.includes("[ ]") && r.includes("Working directory"))).toBe(true);
  });
});
```

If the test file has no local `strip`/`THEMES` helpers yet, add:

```ts
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[7m|\x1b\[27m/g, "");
import { THEMES } from "../src/theme.js";
```

(match however existing cases there handle reverse-video rows).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — `openStatusLine` does not exist.

- [ ] **Step 3: Implement**

In `src/ui/widgets/overlay.ts`:

Add import:

```ts
import { STATUS_LINE_ITEMS, STATUS_LINE_LABELS, canonicalOrder } from "../../statusLineItems.js";
import type { StatusLineItem } from "../../statusLineItems.js";
```

Extend the union (line 12):

```ts
export type OverlayMode = "none" | "resume" | "project" | "permission" | "memory" | "trust" | "statusline";
```

Add state interface near the others:

```ts
interface StatusLineState {
  items: StatusLineItem[];
  enabled: Set<StatusLineItem>;
  index: number;
  onToggle: (next: StatusLineItem[]) => void;
  onCancel: () => void;
}
```

Add field `private statusLineState: StatusLineState | undefined;` alongside the other state fields, extend `close()` with `this.statusLineState = undefined;`, and add:

```ts
  openStatusLine(
    current: StatusLineItem[],
    onToggle: (next: StatusLineItem[]) => void,
    onCancel: () => void
  ): void {
    this._mode = "statusline";
    this.statusLineState = { items: [...STATUS_LINE_ITEMS], enabled: new Set(current), index: 0, onToggle, onCancel };
  }
```

Dispatch in `handleKey`:

```ts
    else if (this._mode === "statusline") this.handleStatusLineKey(k, input);
```

Handler (next to `handleMemoryKey`):

```ts
  private handleStatusLineKey(k: Key, input?: string): void {
    const s = this.statusLineState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.items.length - 1, s.index + 1); return; }
    const toggle = k.t === "enter" || (k.t === "printable" && input === " ");
    if (!toggle) return;
    const item = s.items[s.index];
    if (!item) return;
    if (s.enabled.has(item)) s.enabled.delete(item);
    else s.enabled.add(item);
    s.onToggle(canonicalOrder(s.enabled));
  }
```

Dispatch in `render`:

```ts
    if (this._mode === "statusline") return this.renderStatusLine(theme, width);
```

Renderer (next to `renderMemory`):

```ts
  private renderStatusLine(theme: Theme, width: number): string[] {
    const s = this.statusLineState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Status line (↑/↓ move, Enter/Space toggle, Esc done)${SGR_RESET}`
    ];
    const { start, end } = visibleWindow(s.items.length, s.index, MAX_ROWS);
    for (let i = start; i < end; i++) {
      const item = s.items[i];
      const line = (s.enabled.has(item) ? "[x] " : "[ ] ") + STATUS_LINE_LABELS[item];
      rows.push(i === s.index ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/overlay.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/overlay.ts tests/overlay.test.ts
git commit -m "feat: add statusline toggle overlay"
```

---

### Task 5: Picker wiring and /statusline command

**Files:**
- Modify: `src/ui/appPickers.ts`
- Modify: `src/commands/types.ts`
- Modify: `src/commands/builtins.ts`
- Test: `tests/appPickers.test.ts` (add case)
- Test: `tests/commands.test.ts` (add case)

**Interfaces:**
- Consumes: `openStatusLine` on `OverlayManager` (Task 4); `CommandContext` shape (existing).
- Produces:
  - `openStatusLinePicker(deps: PickerDeps, initial: StatusLineItem[], onChange: (next: StatusLineItem[]) => void): void` in `appPickers.ts`
  - `CommandContext.openStatusLinePicker(): void` (no args — App owns the current list)
  - `/statusline` command: any invocation with args prints `Usage: /statusline`; bare invocation calls `ctx.openStatusLinePicker()`

- [ ] **Step 1: Write the failing tests**

Append to `tests/appPickers.test.ts` inside the existing describe (reuse its `setup()` helper):

```ts
  it("openStatusLinePicker opens the toggle list and repaints", async () => {
    const { openStatusLinePicker } = await import("../src/ui/appPickers.js");
    const { deps, overlay, repaints } = setup();
    const changes: string[][] = [];
    openStatusLinePicker(deps, ["model", "cost"], next => changes.push(next));
    expect(overlay.mode).toBe("statusline");
    expect(repaints()).toBe(1);
    overlay.handleKey({ t: "down" });
    overlay.handleKey({ t: "enter" });
    expect(changes).toHaveLength(1);
    overlay.handleKey({ t: "esc" });
    expect(overlay.mode).toBe("none");
  });
```

(Simpler alternative: add `openStatusLinePicker` to the existing named import on line 5 instead of the dynamic import — prefer that.)

Append to `tests/commands.test.ts`, following its existing fake-context style (the file builds a ctx object with `vi.fn()` members — add `openStatusLinePicker: vi.fn(),` to that fixture):

```ts
it("/statusline opens the picker", async () => {
  await runCommand("statusline", "", ctx);
  expect(ctx.openStatusLinePicker).toHaveBeenCalledTimes(1);
});

it("/statusline rejects arguments with a usage hint", async () => {
  await runCommand("statusline", "cost", ctx);
  expect(ctx.openStatusLinePicker).not.toHaveBeenCalled();
  expect(notices.join("\n")).toContain("Usage: /statusline");
});
```

Match the file's actual invocation helper (how other commands like `/memory` are invoked around line 444) rather than a literal `runCommand` — the assertions are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/appPickers.test.ts tests/commands.test.ts`
Expected: FAIL — `openStatusLinePicker` not exported / not on CommandContext fixture.

- [ ] **Step 3: Implement**

`src/ui/appPickers.ts` — add imports and function (update the header comment's list of overlays to include the statusline picker):

```ts
import type { StatusLineItem } from "../statusLineItems.js";

/** Toggle list for /statusline: every change flows through onChange so the
 * app can persist and repaint while the overlay stays open. */
export function openStatusLinePicker(
  deps: PickerDeps,
  initial: StatusLineItem[],
  onChange: (next: StatusLineItem[]) => void
): void {
  deps.overlay.openStatusLine(initial, onChange, cancel(deps));
  deps.recompute();
}
```

`src/commands/types.ts` — add to `CommandContext` (near `openMemoryPicker(): void;`):

```ts
  openStatusLinePicker(): void;
```

`src/commands/builtins.ts` — add command (place it next to the `memory` entry):

```ts
  {
    name: "statusline",
    description: "Choose which segments the status bar shows",
    async run(ctx, args) {
      if (args.trim()) { ctx.notice("Usage: /statusline"); return; }
      ctx.openStatusLinePicker();
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/appPickers.test.ts tests/commands.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/appPickers.ts src/commands/types.ts src/commands/builtins.ts tests/appPickers.test.ts tests/commands.test.ts
git commit -m "feat: wire /statusline picker through command surface"
```

---

### Task 6: App integration — live apply and persistence

**Files:**
- Modify: `src/ui/nativeApp.ts`
- Test: `tests/app.test.ts` (add case)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: end-to-end behavior — `/statusline` opens the overlay over the loaded setting; toggling saves to disk, updates the bar immediately; startup uses saved value, falling back to the default set.

- [ ] **Step 1: Write the failing test**

The existing app tests drive `App` via helpers like `submitForTest()` with a temp HOME/config dir (see how `tests/app.test.ts` isolates config). Add a case in that style; if the harness makes the overlay round-trip awkward, assert the two halves separately: (a) `buildCommandContext().openStatusLinePicker()` opens the overlay, and (b) a direct call to the same callback the picker wires persists and recomputes. Example shape (adapt names to the file's fixtures):

```ts
it("/statusline toggles persist to settings.json", async () => {
  const { app, configFile } = makeApp(); // existing temp-config harness
  app.submitForTest("/statusline");
  // overlay is open with the default set
  app.handleKey({ t: "down" }); // servedModel row
  app.handleKey({ t: "enter" }); // toggle on -> persist
  const raw = JSON.parse(readFileSync(configFile, "utf8")) as { statusLineItems?: string[] };
  expect(raw.statusLineItems).toContain("servedModel");
});
```

If no such harness exists, drive `App` the way `tests/app-queue.test.ts` does and assert on the written settings file under the temp config dir the harness points `HOME`/`USERPROFILE` at.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL — `/statusline` currently resolves to no command or does nothing persistent.

- [ ] **Step 3: Implement**

In `src/ui/nativeApp.ts`:

Imports:

```ts
import { openMemoryPicker, openProjectPicker, openResumePicker, openStatusLinePicker, type PickerDeps } from "./appPickers.js";
import { DEFAULT_STATUS_LINE_ITEMS, type StatusLineItem } from "../statusLineItems.js";
```

(`loadSettings`/`saveSetting` already imported at line 34.)

Field (next to `private effort ...` at line 76):

```ts
  private statusLineItems: StatusLineItem[] = loadSettings().statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS;
```

Context method (inside `buildCommandContext()`, next to `openMemoryPicker` at line 357):

```ts
      openStatusLinePicker: () =>
        openStatusLinePicker(this.pickerDeps(), this.statusLineItems, next => {
          this.statusLineItems = next;
          saveSetting("statusLineItems", next);
          this.recompute();
        }),
```

Pass into the bar in `recompute()`'s `statusBarProps` literal (after `elapsedMs`, line 542):

```ts
        items: this.statusLineItems
```

- [ ] **Step 4: Run the whole suite and checks**

Run: `npm test && npm run build && npm run lint && npm run lint:size`
Expected: all green. Fix any fallout (e.g. `tests/render.test.ts` fixtures may need `items` if they assert specific segments — they use minimal props `{provider, mode, cwd}`, which now renders only model+mode under the new default; adjust their assertions to match the documented default if they fail).

- [ ] **Step 5: Manual smoke check**

Run: `npm run dev` in a scratch project, then `/statusline`: toggle `Working directory` off/on, confirm the bottom bar updates instantly and `~/.cloudcode/settings.json` contains `statusLineItems`. Restart and confirm the choice survived.

- [ ] **Step 6: Commit**

```bash
git add src/ui/nativeApp.ts tests/app.test.ts tests/render.test.ts
git commit -m "feat: apply statusLineItems live from /statusline picker"
```
