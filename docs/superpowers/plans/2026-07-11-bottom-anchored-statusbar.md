# Bottom-Anchored Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the InputBox + StatusBar to the terminal's bottom row (like Claude Code) by inserting a measured blank filler above them while total content is shorter than the terminal.

**Architecture:** A new pure module `src/ui/bottomFill.ts` estimates how many terminal rows the `<Static>` transcript occupies (Ink cannot measure scrollback) and computes the filler height. `App.tsx` measures the live region's actual rendered height with Ink's `measureElement`, computes `filler = max(0, rows - staticRows - dynamicRows - 1)`, and renders a `<Box height={filler}>` between the transcript and the live region. Once output exceeds one screen, filler is 0 and behavior is unchanged.

**Tech Stack:** Ink 5 (`measureElement`, `useStdout`), React 18, vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-11-bottom-anchored-statusbar-design.md`

## Global Constraints

- All code, comments, and names in English only.
- The total rendered dynamic height (filler + live region) must stay strictly under `stdout.rows` — reserve 1 row — or Ink enters clear-whole-screen repaint mode and breaks mouse scrolling (see comment at `src/ui/App.tsx:380`).
- Follow existing wrap math convention from `src/ui/streamTail.ts`: `Math.max(1, Math.ceil(length / width))` per line.
- Fallbacks when stdout is unavailable: `rows ?? 24`, `columns ?? 80` (same as existing code at `App.tsx:391`).

---

### Task 1: Pure row-math module `bottomFill.ts`

**Files:**
- Create: `src/ui/bottomFill.ts`
- Test: `tests/bottom-fill.test.ts`

**Interfaces:**
- Consumes: `DisplayItem` from `src/ui/transcript.ts`, `renderMarkdown` from `src/ui/markdown.ts`.
- Produces (Task 2 relies on these exact signatures):
  - `staticRows(items: DisplayItem[], columns: number, cap: number): number` — estimated terminal rows the transcript occupies, early-exits at `cap` (pass `stdout.rows`; anything ≥ cap means filler is 0 anyway).
  - `fillerHeight(terminalRows: number, staticRows: number, dynamicRows: number): number` — blank rows to insert, clamped ≥ 0, reserving 1 row.
  - `itemRows(item: DisplayItem, columns: number): number` — rows for one item (exported for tests).

Rendering-shape notes the row estimates must mirror (`src/ui/MessageList.tsx:renderItem`):
- `user` items render as `"> " + text`; `tool` as `"⏺ " + label`.
- `assistant` items render through `renderMarkdown()`, whose output contains ANSI color codes — strip them before measuring length, or wrap counts are inflated.
- `diff` items render each line as `"${sign} ${text}"` inside a `marginLeft={2}` Box, so their effective width is `columns - 2`.
- `result` items are always one line.

- [ ] **Step 1: Write the failing tests**

Create `tests/bottom-fill.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { itemRows, staticRows, fillerHeight } from "../src/ui/bottomFill.js";
import type { DisplayItem } from "../src/ui/transcript.js";

describe("itemRows", () => {
  it("counts a single-line notice as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "hello" }, 80)).toBe(1);
  });

  it("counts multi-line text by newlines", () => {
    expect(itemRows({ kind: "notice", text: "a\nb\nc" }, 80)).toBe(3);
  });

  it("counts wrapped lines: user prefix '> ' pushes 79 chars to 2 rows at width 80", () => {
    // "> " (2 chars) + 79 chars = 81 chars -> 2 rows
    expect(itemRows({ kind: "user", text: "x".repeat(79) }, 80)).toBe(2);
  });

  it("counts an empty line as 1 row", () => {
    expect(itemRows({ kind: "notice", text: "" }, 80)).toBe(1);
  });

  it("result items are 1 row", () => {
    expect(itemRows({ kind: "result", costUsd: 0.01, durationMs: 1000 }, 80)).toBe(1);
  });

  it("diff items account for the 2-column margin", () => {
    // Each diff line renders as "+ xxx" in width (80 - 2) = 78.
    // sign+space (2) + 77 chars = 79 chars > 78 -> 2 rows.
    const lines = [{ sign: "+" as const, text: "y".repeat(77) }];
    expect(itemRows({ kind: "diff", lines }, 80)).toBe(2);
  });

  it("strips ANSI codes from assistant markdown before measuring", () => {
    // renderMarkdown emits ANSI-styled output; a short bold word must
    // still count as 1 row even though escape bytes inflate raw length.
    expect(itemRows({ kind: "assistant", text: "**hi**" }, 10)).toBe(1);
  });
});

describe("staticRows", () => {
  const notice = (text: string): DisplayItem => ({ kind: "notice", text });

  it("sums rows across items", () => {
    expect(staticRows([notice("a"), notice("b\nc")], 80, 100)).toBe(3);
  });

  it("early-exits at cap", () => {
    const items = Array.from({ length: 50 }, () => notice("line"));
    expect(staticRows(items, 80, 10)).toBe(10);
  });

  it("returns 0 for an empty transcript", () => {
    expect(staticRows([], 80, 24)).toBe(0);
  });
});

describe("fillerHeight", () => {
  it("fills unused space minus the 1-row reserve", () => {
    // 24 rows, 5 transcript rows, 6 live-region rows -> 24 - 5 - 6 - 1 = 12
    expect(fillerHeight(24, 5, 6)).toBe(12);
  });

  it("returns 0 on exact fit", () => {
    expect(fillerHeight(24, 17, 6)).toBe(0);
  });

  it("clamps to 0 on overflow", () => {
    expect(fillerHeight(24, 100, 6)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bottom-fill.test.ts`
Expected: FAIL — cannot resolve `../src/ui/bottomFill.js`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/bottomFill.ts`:

```ts
// The transcript renders through <Static> into terminal scrollback, outside
// Ink's layout tree, so its height cannot be measured with measureElement.
// Instead we estimate its rows with the same wrap math as streamTail.ts,
// mirroring how MessageList.renderItem shapes each item. This estimate only
// matters while total content is shorter than the terminal (the filler is 0
// otherwise), so small drift on exotic markdown is acceptable.
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function wrappedRows(line: string, columns: number): number {
  const width = Math.max(1, columns);
  const visible = line.replace(ANSI_RE, "").length;
  return Math.max(1, Math.ceil(visible / width));
}

function textRows(text: string, columns: number): number {
  return text.split("\n").reduce((sum, line) => sum + wrappedRows(line, columns), 0);
}

export function itemRows(item: DisplayItem, columns: number): number {
  switch (item.kind) {
    case "user":
      return textRows("> " + item.text, columns);
    case "assistant":
      return textRows(renderMarkdown(item.text), columns);
    case "tool":
      return textRows("⏺ " + item.label, columns);
    case "notice":
    case "error":
      return textRows(item.text, columns);
    case "diff":
      return item.lines.reduce(
        (sum, l) => sum + wrappedRows(`${l.sign} ${l.text}`, Math.max(1, columns - 2)),
        0
      );
    case "result":
      return 1;
  }
}

export function staticRows(items: DisplayItem[], columns: number, cap: number): number {
  let rows = 0;
  for (const item of items) {
    rows += itemRows(item, columns);
    if (rows >= cap) return cap;
  }
  return rows;
}

export function fillerHeight(terminalRows: number, staticRows: number, dynamicRows: number): number {
  return Math.max(0, terminalRows - staticRows - dynamicRows - 1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bottom-fill.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/bottomFill.ts tests/bottom-fill.test.ts
git commit -m "feat(ui): row math for bottom-anchored footer filler"
```

---

### Task 2: Wire filler + measurement into App.tsx

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `tests/app.test.tsx` (append one test)

**Interfaces:**
- Consumes from Task 1: `staticRows(items, columns, cap)`, `fillerHeight(terminalRows, staticRows, dynamicRows)` from `src/ui/bottomFill.js`.
- Consumes from Ink: `measureElement(node): { width, height }` and the `DOMElement` type (both exported by `ink`).
- Produces: no new exports; App renders a filler `<Box>` and wraps the live region in a ref'd `<Box>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/app.test.tsx` (uses the existing `makeApp()` and `wait()` helpers in that file):

```tsx
describe("bottom-anchored footer", () => {
  it("pads a short transcript so the status bar sits near the terminal bottom", async () => {
    const { lastFrame } = makeApp();
    await wait();
    const lines = lastFrame()!.split("\n");
    // ink-testing-library has no real TTY, so App falls back to 24 rows.
    // Welcome banner + filler + input box + status bar should fill the
    // screen to within the 1-row reserve. Without the filler the frame
    // is only ~6-10 lines tall.
    expect(lines.length).toBeGreaterThanOrEqual(20);
    // Status bar (provider segment) must be the last line.
    expect(lines[lines.length - 1]).toContain("anthropic");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx -t "bottom-anchored"`
Expected: FAIL — `lines.length` is well under 20 (no filler exists yet).

- [ ] **Step 3: Implement in App.tsx**

3a. Extend the ink import at `src/ui/App.tsx:2` and add the bottomFill import:

```tsx
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
```

```tsx
import { staticRows, fillerHeight } from "./bottomFill.js";
```

3b. Add state/refs near the other hooks (after the `workStartedAt` state around `App.tsx:102`):

```tsx
  const liveRegionRef = useRef<DOMElement>(null);
  const [dynamicRows, setDynamicRows] = useState(0);
  const [termSize, setTermSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
```

3c. Add effects next to the existing elapsed-timer effect (`App.tsx:233`):

```tsx
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Re-measure the live region after every render; only write state when the
  // height actually changed so this cannot loop.
  useEffect(() => {
    if (!liveRegionRef.current) return;
    const { height } = measureElement(liveRegionRef.current);
    setDynamicRows(prev => (prev === height ? prev : height));
  });
```

3d. Compute filler in the render body, just before `return`:

```tsx
  const transcriptRows = staticRows(items, termSize.columns, termSize.rows);
  const filler = fillerHeight(termSize.rows, transcriptRows, dynamicRows);
```

3e. Restructure the JSX: insert the filler after `<MessageList>`, and wrap everything below it (stream tail through StatusBar) in a ref'd column Box. The filler must stay OUTSIDE the measured box, or it would count itself. Final JSX shape:

```tsx
  return (
    <ThemeProvider theme={THEMES[themeName] ?? THEMES.dark}>
      <Box flexDirection="column">
        <MessageList items={items} staticKey={transcriptKey} />
        {/* Blank space pushing the footer to the terminal's bottom edge while
            the transcript is shorter than the screen (Claude Code-style).
            Sized from estimated transcript rows (Static scrollback cannot be
            measured) plus the measured live region below; goes to 0 once
            output exceeds one screen. Kept outside liveRegionRef so the
            measurement does not include the filler itself. */}
        {filler > 0 && <Box height={filler} flexShrink={0} />}
        <Box flexDirection="column" ref={liveRegionRef}>
          {/* ...everything currently between MessageList and </Box>:
              streamText <Text>, WorkingIndicator, ProgressBar, ResumePicker,
              ProjectPicker, PermissionDialog, InputBox, StatusBar —
              all unchanged. */}
        </Box>
      </Box>
    </ThemeProvider>
  );
```

3f. In the stream-tail cap on the same JSX (currently `App.tsx:391`), replace the direct stdout reads with the tracked size so tail math and filler math agree after a resize:

```tsx
            {tailForHeight(streamText, Math.max(3, termSize.rows - 14), termSize.columns)}
```

- [ ] **Step 4: Run the new test, then the full suite**

Run: `npx vitest run tests/app.test.tsx -t "bottom-anchored"`
Expected: PASS.

Run: `npx vitest run`
Expected: all tests PASS. If an existing `app.test.tsx` assertion breaks because frames gained blank lines, fix that assertion to be filler-tolerant (e.g. match on line content, not frame height) — do not weaken the new test.

- [ ] **Step 5: Verify visually**

Run the app in a real terminal (`npm run dev` or the project's usual start command) and confirm: on startup the input box + status bar sit at the bottom edge with blank space under the banner; as messages accumulate the gap shrinks; after the transcript exceeds one screen, behavior matches today's.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx tests/app.test.tsx
git commit -m "feat(ui): pin input box and status bar to terminal bottom"
```
