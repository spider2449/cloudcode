# TUI Display Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native TUI measure terminal columns correctly (CJK/emoji), display messages with Claude Code-quality structure (spacing, tool results, real diffs, word wrapping), and make paste work in legacy conhost.

**Architecture:** A new `src/ui/width.ts` module becomes the single source of truth for terminal column math; every layout site (`wrapText`, `truncate`, `tailForHeight`, input box, status bar) switches from `.length` to it. The engine emits a new `tool_result` message so the transcript can show tool output previews. `KeyDecoder` coalesces multi-key stdin chunks into paste events for terminals without bracketed paste.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest. No new dependencies.

## Global Constraints

- All code comments in English (user's global CLAUDE.md rule).
- No emitted terminal row may exceed the terminal width in *columns* — legacy conhost ignores `DECAWM ?7l` (see `MEMORY.md` conhost note).
- Unknown code points default to width 1; over-estimating width is safe, under-estimating causes conhost scroll corruption.
- The legacy Ink UI (`src/ui/App.tsx` and `.tsx` widgets) is untouched.
- Run tests with `npx vitest run <file>`; full suite with `npx vitest run`.
- Commit after every task with a conventional-commit message ending in the Co-Authored-By trailer.

---

### Task 1: Width foundation (`src/ui/width.ts`)

**Files:**
- Create: `src/ui/width.ts`
- Test: `tests/width.test.ts`

**Interfaces:**
- Produces: `charWidth(cp: number): number`, `stringWidth(s: string): number` (ANSI-SGR-aware), `truncateToWidth(s: string, max: number): string` (strips ANSI, appends `…`). All later tasks import these from `./width.js` (from `src/ui`) or `../width.js` (from `src/ui/widgets`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/width.test.ts
import { describe, it, expect } from "vitest";
import { charWidth, stringWidth, truncateToWidth } from "../src/ui/width.js";

describe("charWidth", () => {
  it("gives ASCII width 1", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
  });
  it("gives CJK ideographs width 2", () => {
    expect(charWidth("中".codePointAt(0)!)).toBe(2);
    expect(charWidth("文".codePointAt(0)!)).toBe(2);
  });
  it("gives kana and hangul width 2", () => {
    expect(charWidth("あ".codePointAt(0)!)).toBe(2);
    expect(charWidth("한".codePointAt(0)!)).toBe(2);
  });
  it("gives fullwidth forms width 2", () => {
    expect(charWidth("Ａ".codePointAt(0)!)).toBe(2);
    expect(charWidth("，".codePointAt(0)!)).toBe(2);
  });
  it("gives emoji width 2", () => {
    expect(charWidth("😀".codePointAt(0)!)).toBe(2);
  });
  it("gives combining marks, ZWJ and variation selectors width 0", () => {
    expect(charWidth(0x0301)).toBe(0); // combining acute
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // variation selector-16
  });
  it("gives control characters width 0", () => {
    expect(charWidth(0x1b)).toBe(0);
  });
});

describe("stringWidth", () => {
  it("sums mixed ASCII and CJK", () => {
    expect(stringWidth("ab中文")).toBe(6);
  });
  it("ignores ANSI SGR sequences", () => {
    expect(stringWidth("\x1b[31m中\x1b[0m")).toBe(2);
  });
  it("handles surrogate-pair emoji as one code point", () => {
    expect(stringWidth("😀")).toBe(2);
  });
  it("returns 0 for empty string", () => {
    expect(stringWidth("")).toBe(0);
  });
});

describe("truncateToWidth", () => {
  it("returns short strings unchanged", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
  });
  it("truncates by columns, not chars", () => {
    // 5 CJK chars = 10 columns; max 6 leaves room for 5 columns + ellipsis
    expect(truncateToWidth("中文字符串", 6)).toBe("中文…");
  });
  it("truncates ASCII to max-1 columns plus ellipsis", () => {
    expect(truncateToWidth("abcdefgh", 5)).toBe("abcd…");
  });
  it("never splits a wide char in half", () => {
    // "a" + "中" would be 3 columns; max 4 minus ellipsis leaves 3 → fits "a中"
    expect(truncateToWidth("a中文文", 4)).toBe("a中…");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/width.test.ts`
Expected: FAIL — cannot resolve `../src/ui/width.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/width.ts
// Terminal column arithmetic. All layout math in the native TUI must use
// these instead of String.length: CJK characters occupy 2 columns, emoji 2,
// combining marks 0. Under-counting a row's width lets it overflow the
// terminal, which on legacy conhost (DECAWM ignored) wraps, scrolls the
// region and corrupts the pinned footer.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Column width of a single Unicode code point. Unknown ranges default to 1
 * (over-estimating is harmless; under-estimating causes the conhost bug). */
export function charWidth(cp: number): number {
  if (cp === 0x200d) return 0; // zero-width joiner
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritical marks
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control chars
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)   // CJK ext B..
  ) {
    return 2;
  }
  return 1;
}

/** Visible column width of a string; ANSI SGR sequences count as 0. */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncate to at most `max` columns, appending "…" when cut. Strips ANSI. */
export function truncateToWidth(s: string, max: number): string {
  const plain = s.replace(ANSI_RE, "");
  if (stringWidth(plain) <= max) return plain;
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/width.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/width.ts tests/width.test.ts
git commit -m "feat(ui): add terminal column width module (CJK/emoji aware)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Width-aware, word-boundary `wrapText` (`src/ui/layout.ts`)

**Files:**
- Modify: `src/ui/layout.ts` (replace `wrapText` and `visibleLength`)
- Test: `tests/layout-wrap.test.ts` (new)

**Interfaces:**
- Consumes: `charWidth`, `stringWidth` from Task 1.
- Produces: `wrapText(text: string, width: number): string[]` — same signature as today, now column-correct and word-breaking. All existing callers (`layout.ts`, `term/render.ts`) keep working unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/layout-wrap.test.ts
import { describe, it, expect } from "vitest";
import { wrapText, stripAnsi } from "../src/ui/layout.js";
import { stringWidth } from "../src/ui/width.js";

describe("wrapText (column-aware)", () => {
  it("wraps CJK by columns: 6 wide chars at width 10 -> rows of 5+1 chars? no: 3 rows? -> 2 rows", () => {
    // 6 CJK chars = 12 columns; width 10 fits 5 chars (10 cols) per row.
    const rows = wrapText("中文字符串測", 10);
    expect(rows).toEqual(["中文字符串", "測"]);
  });
  it("never emits a row wider than the limit", () => {
    const rows = wrapText("中a文b字c符d串e測f", 7);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(7);
  });
  it("breaks at word boundaries for ASCII", () => {
    expect(wrapText("hello brave new world", 11)).toEqual(["hello brave", "new world"]);
  });
  it("hard-cuts a single word longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("allows breaking anywhere in CJK runs", () => {
    expect(wrapText("這是一段很長的中文句子", 8)).toEqual(["這是一段", "很長的中", "文句子"]);
  });
  it("preserves explicit newlines and blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
  it("keeps ANSI codes attached without counting them", () => {
    const rows = wrapText("\x1b[31mred\x1b[0m and more text", 8);
    expect(stripAnsi(rows[0])).toBe("red and");
    expect(rows[0]).toContain("\x1b[31m");
  });
  it("mixed CJK and ASCII wraps by columns", () => {
    // "ab中文" = 2 + 4 = 6 columns; width 5 → "ab中" (4 cols, next char won't fit)
    expect(wrapText("ab中文", 5)).toEqual(["ab中", "文"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout-wrap.test.ts`
Expected: FAIL — current char-count wrap returns wrong rows for CJK and does not word-break.

- [ ] **Step 3: Replace `wrapText` in `src/ui/layout.ts`**

Replace the `visibleLength` function and the whole `wrapText` function (keep `stripAnsi`, `ANSI_RE`, `ANSI_TOKEN_RE` and everything below `wrapText` unchanged):

```ts
import { charWidth, stringWidth } from "./width.js";

function visibleWidth(s: string): number {
  return stringWidth(s);
}

// Wraps at `width` visible terminal columns (CJK chars count 2), keeping
// embedded ANSI codes attached to the text they color. Breaks preferentially
// at spaces or after CJK characters (Chinese may break between any two
// characters); a single over-long word is hard-cut. Explicit "\n" starts a
// new wrap unit, mirroring bottomFill.ts's per-line row counting.
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (visibleWidth(line) === 0) {
      // Blank line, or ANSI-only content: keep blanks; re-attach ANSI-only
      // fragments (e.g. a trailing reset) to the previous emitted row.
      if (stripAnsi(line) === "") {
        if (line !== "" && out.length > 0) out[out.length - 1] += line;
        else out.push("");
      } else {
        out.push("");
      }
      continue;
    }
    let row = "";      // current row, including ANSI codes
    let rowW = 0;      // visible columns in `row`
    let breakAt = -1;  // string index into `row` after the last break chance
    let i = 0;
    while (i < line.length) {
      const escMatch = ANSI_TOKEN_RE.exec(line.slice(i));
      if (escMatch) {
        row += escMatch[0];
        i += escMatch[0].length;
        continue;
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const cw = charWidth(cp);
      if (rowW + cw > w) {
        if (ch === " ") {
          // The overflowing char is the break itself: emit the full row and
          // swallow the space instead of backtracking to an earlier break.
          out.push(row.replace(/ +$/, ""));
          row = "";
          rowW = 0;
          breakAt = -1;
          i += 1;
          continue;
        }
        if (breakAt > 0) {
          out.push(row.slice(0, breakAt).replace(/ +$/, ""));
          row = row.slice(breakAt).replace(/^ +/, "");
        } else {
          out.push(row);
          row = "";
        }
        rowW = stringWidth(row);
        breakAt = -1;
        continue; // retry the same character on the fresh row
      }
      row += ch;
      rowW += cw;
      i += ch.length;
      // Break opportunities: after a space, or after any wide (CJK) char.
      if (ch === " " || cw === 2) breakAt = row.length;
    }
    if (rowW > 0) out.push(row);
    else if (row !== "" && out.length > 0) out[out.length - 1] += row;
  }
  return out;
}
```

Also update the one remaining `visibleLength` caller if any (search for `visibleLength` in the file — it existed only for `wrapText`; delete it if unused).

- [ ] **Step 4: Run the new test and the existing suites**

Run: `npx vitest run tests/layout-wrap.test.ts tests/messageList.test.tsx tests/bottom-fill.test.ts tests/terminal.test.ts`
Expected: PASS. If an existing test asserted exact char-cut wrapping (e.g. mid-word cuts), update that test's expectation to the word-boundary result and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout.ts tests/layout-wrap.test.ts
git commit -m "feat(ui): column-aware word wrapping for CJK and ANSI text

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Width-aware `truncate` and `tailForHeight`

**Files:**
- Modify: `src/ui/transcript.ts` (function `truncate`, lines 15–17)
- Modify: `src/ui/streamTail.ts` (row counting, line 14)
- Test: `tests/streamTail.test.ts` (extend), `tests/width.test.ts` already covers truncation core

**Interfaces:**
- Consumes: `stringWidth`, `truncateToWidth` from Task 1.
- Produces: `truncate(s: string, max = 80): string` keeps its signature but counts columns. `tailForHeight` keeps its signature.

- [ ] **Step 1: Write the failing test**

Append to `tests/streamTail.test.ts`:

```ts
import { stringWidth } from "../src/ui/width.js";

describe("tailForHeight CJK rows", () => {
  it("counts a CJK line as its column width, not char count", () => {
    // 10 CJK chars = 20 columns = 2 rows at width 10.
    const text = ["第一行的中文內容啊啊", "second"].join("\n");
    // maxRows 2: the CJK line alone already fills 2 rows, so only the last
    // line(s) fitting must be kept.
    const out = tailForHeight(text, 2, 10);
    expect(out).toBe("second");
  });
});
```

(Match the existing import style at the top of the file; `tailForHeight` is already imported there.)

And append to `tests/width.test.ts` — a `truncate` regression via transcript:

```ts
import { truncate } from "../src/ui/transcript.js";

describe("transcript truncate (column-aware)", () => {
  it("truncates CJK by columns", () => {
    // 50 CJK chars = 100 columns > 80 → must cut well before 50 chars.
    const s = "中".repeat(50);
    const out = truncate(s);
    expect(out.endsWith("…")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(80);
  });
  it("respects an explicit max width", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/streamTail.test.ts tests/width.test.ts`
Expected: FAIL — old code counts chars.

- [ ] **Step 3: Implement**

In `src/ui/transcript.ts`, replace `truncate`:

```ts
import { stringWidth, truncateToWidth } from "./width.js";

export function truncate(s: string, max = 80): string {
  return stringWidth(s) > max ? truncateToWidth(s, max) : s;
}
```

In `src/ui/streamTail.ts`, replace the row-count line (`rows += Math.max(1, Math.ceil(line.length / width));`):

```ts
import { stringWidth } from "./width.js";
// ...inside the loop:
    rows += Math.max(1, Math.ceil(stringWidth(line) / width));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/streamTail.test.ts tests/width.test.ts tests/messageList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/transcript.ts src/ui/streamTail.ts tests/streamTail.test.ts tests/width.test.ts
git commit -m "fix(ui): count terminal columns in truncate and stream tail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Width-aware input box and status bar

**Files:**
- Modify: `src/ui/widgets/inputBox.ts` (private `wrap`, lines 152–161)
- Modify: `src/ui/widgets/statusBar.ts` (segment packing, lines 49–58)
- Test: `tests/inputBox-width.test.ts` (new), `tests/statusBar.test.tsx` (extend)

**Interfaces:**
- Consumes: `charWidth`, `stringWidth`, `truncateToWidth` from Task 1 (import path `../width.js`).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/inputBox-width.test.ts
import { describe, it, expect } from "vitest";
import { InputBox } from "../src/ui/widgets/inputBox.js";
import { History } from "../src/agent/history.js";
import { stringWidth } from "../src/ui/width.js";

const ctx = {
  registry: { get: () => undefined, list: () => [] },
  providerNames: () => [],
  availableModels: () => [],
  listFiles: () => []
} as never;

const theme = { muted: "gray" } as never;

describe("InputBox CJK wrapping", () => {
  it("never renders a content row wider than the terminal", () => {
    const box = new InputBox(ctx, new History());
    for (const ch of "這是一段非常長的中文輸入內容測試字串") {
      box.handleKey({ t: "printable", ch }, false);
    }
    const r = box.render(theme, 20, false);
    for (const row of r.contentRows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(16); // innerWidth = width - 4
    }
  });
});
```

Append to `tests/statusBar.test.tsx`:

```ts
import { stringWidth } from "../src/ui/width.js";

describe("status bar CJK width", () => {
  it("packs segments by columns so no row exceeds the width", () => {
    const rows = renderStatusBar(
      { provider: "p", mode: "default", cwd: "D:\\專案\\中文路徑名稱很長很長" },
      { muted: undefined } as never,
      20
    );
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(20);
  });
});
```

(Match the existing imports/render helpers at the top of `tests/statusBar.test.tsx`; `renderStatusBar` is already imported there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inputBox-width.test.ts tests/statusBar.test.tsx`
Expected: FAIL — CJK rows exceed the width.

- [ ] **Step 3: Implement**

`src/ui/widgets/inputBox.ts` — replace the private `wrap` method:

```ts
import { charWidth } from "../width.js";

  private wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) { out.push(""); continue; }
      let row = "";
      let w = 0;
      for (const ch of line) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (w + cw > width) { out.push(row); row = ""; w = 0; }
        row += ch;
        w += cw;
      }
      out.push(row);
    }
    return out;
  }
```

`src/ui/widgets/statusBar.ts` — replace the packing loop (keep everything above `const SEP` unchanged):

```ts
import { stringWidth, truncateToWidth } from "../width.js";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inputBox-width.test.ts tests/statusBar.test.tsx tests/inputBox.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/inputBox.ts src/ui/widgets/statusBar.ts tests/inputBox-width.test.ts tests/statusBar.test.tsx
git commit -m "fix(ui): column-aware input box wrapping and status bar packing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Transcript item spacing (`src/ui/buffer.ts`)

**Files:**
- Modify: `src/ui/buffer.ts` (`takeCommitRows`)
- Test: `tests/buffer-spacing.test.ts` (new)

**Interfaces:**
- Consumes: `layoutItem` (unchanged), `DisplayItem`.
- Produces: `takeCommitRows` emits one blank row before each `user`, `assistant`, and `welcome` item except the very first item in the buffer. Tool/diff/result/notice/error items stay tight.

- [ ] **Step 1: Write the failing test**

```ts
// tests/buffer-spacing.test.ts
import { describe, it, expect } from "vitest";
import { Buffer } from "../src/ui/buffer.js";

const theme = {} as never;

describe("transcript spacing", () => {
  it("puts a blank row before user and assistant items, but not the first item", () => {
    const b = new Buffer();
    b.append({ kind: "user", text: "hi" });
    b.append({ kind: "assistant", text: "hello" });
    const rows = b.takeCommitRows(80, theme);
    expect(rows[0]).not.toBe("");            // no leading blank at the top
    expect(rows).toContain("");              // blank separator exists
    const blankIdx = rows.indexOf("");
    expect(rows[blankIdx + 1]).toContain("hello"); // separator sits before the assistant block
  });
  it("keeps tool items tight against the previous item", () => {
    const b = new Buffer();
    b.append({ kind: "assistant", text: "x" });
    b.append({ kind: "tool", label: "Bash ls" });
    const rows = b.takeCommitRows(80, theme);
    expect(rows.filter(r => r === "").length).toBe(0);
  });
  it("spacing survives recommitAll (resize reprint)", () => {
    const b = new Buffer();
    b.append({ kind: "user", text: "a" });
    b.append({ kind: "user", text: "b" });
    b.takeCommitRows(80, theme);
    b.recommitAll();
    const again = b.takeCommitRows(80, theme);
    expect(again.filter(r => r === "").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buffer-spacing.test.ts`
Expected: FAIL — no blank rows emitted today.

- [ ] **Step 3: Implement in `src/ui/buffer.ts`**

Replace `takeCommitRows`:

```ts
const SPACED_KINDS = new Set(["user", "assistant", "welcome"]);

  /** Lay out all not-yet-committed items and mark them committed. Emits one
   * blank separator row before user/assistant/welcome blocks (except the
   * first item) so the transcript has vertical rhythm; tool groups stay
   * tight. Spacing is index-based, so a resize recommit reproduces it. */
  takeCommitRows(width: number, theme: Theme): string[] {
    const rows: string[] = [];
    for (; this.committed < this.items.length; this.committed++) {
      const item = this.items[this.committed];
      if (this.committed > 0 && SPACED_KINDS.has(item.kind)) rows.push("");
      rows.push(...layoutItem(item, theme, width));
    }
    return rows;
  }
```

(`SPACED_KINDS` goes at module scope, above the class.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/buffer-spacing.test.ts tests/messageList.test.tsx tests/terminal.test.ts`
Expected: PASS. If a renderer test asserts exact committed row sequences, update its expectation to include the separator rows.

- [ ] **Step 5: Commit**

```bash
git add src/ui/buffer.ts tests/buffer-spacing.test.ts
git commit -m "feat(ui): add vertical rhythm between transcript blocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Tool result display (engine → transcript → layout)

**Files:**
- Modify: `src/engine/messages.ts` (new union member + helper)
- Modify: `src/engine/loop.ts` (emit after each tool run, in `run()` around line 110)
- Modify: `src/ui/transcript.ts` (`DisplayItem` union + `toDisplayItems`)
- Modify: `src/ui/layout.ts` (`layoutItem` new case)
- Modify: `src/ui/buffer.ts` (nothing — `toolResult` is not in `SPACED_KINDS`, stays tight)
- Test: `tests/toolResult.test.ts` (new)

**Interfaces:**
- Produces (engine): `EngineMessage` gains `{ type: "tool_result"; tool_use_id: string; content: unknown; is_error: boolean }` and helper `toolResultMessage(tool_use_id: string, content: unknown, is_error: boolean): EngineMessage`.
- Produces (UI): `DisplayItem` gains `{ kind: "toolResult"; text: string; extra: number; isError: boolean }` where `text` is the first non-empty output line and `extra` is the count of further non-empty lines.

- [ ] **Step 1: Write the failing test**

```ts
// tests/toolResult.test.ts
import { describe, it, expect } from "vitest";
import { toDisplayItems } from "../src/ui/transcript.js";
import { layoutItem } from "../src/ui/layout.js";
import { toolResultMessage } from "../src/engine/messages.js";
import { stripAnsi } from "../src/ui/layout.js";

const theme = { muted: "gray", error: "red" } as never;

describe("tool_result display", () => {
  it("maps a string result to a one-line preview with extra-line count", () => {
    const items = toDisplayItems(toolResultMessage("t1", "line one\nline two\nline three", false));
    expect(items).toEqual([{ kind: "toolResult", text: "line one", extra: 2, isError: false }]);
  });
  it("maps structured content blocks by joining their text", () => {
    const items = toDisplayItems(toolResultMessage("t1", [{ type: "text", text: "hello" }], false));
    expect(items).toEqual([{ kind: "toolResult", text: "hello", extra: 0, isError: false }]);
  });
  it("shows (no output) for empty content", () => {
    const items = toDisplayItems(toolResultMessage("t1", "", false));
    expect(items).toEqual([{ kind: "toolResult", text: "(no output)", extra: 0, isError: false }]);
  });
  it("marks errors", () => {
    const items = toDisplayItems(toolResultMessage("t1", "boom", true));
    expect(items[0]).toMatchObject({ isError: true });
  });
  it("renders as an indented ⎿ line, width-truncated", () => {
    const rows = layoutItem({ kind: "toolResult", text: "x".repeat(200), extra: 3, isError: false }, theme, 40);
    expect(rows.length).toBe(1);
    const plain = stripAnsi(rows[0]);
    expect(plain.startsWith("  ⎿ ")).toBe(true);
    expect(plain.length).toBeLessThanOrEqual(40);
    expect(plain.endsWith("…")).toBe(true);
  });
  it("appends the extra-line suffix when it fits", () => {
    const rows = layoutItem({ kind: "toolResult", text: "ok", extra: 4, isError: false }, theme, 40);
    expect(stripAnsi(rows[0])).toBe("  ⎿ ok (+4 lines)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/toolResult.test.ts`
Expected: FAIL — `toolResultMessage` does not exist.

- [ ] **Step 3: Implement**

`src/engine/messages.ts` — add to the `EngineMessage` union:

```ts
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error: boolean }
```

and add the helper:

```ts
export function toolResultMessage(tool_use_id: string, content: unknown, is_error: boolean): EngineMessage {
  return { type: "tool_result", tool_use_id, content, is_error };
}
```

`src/engine/loop.ts` — in `run()`, replace the tool loop body:

```ts
        const results = [];
        for (const block of turn.blocks) {
          if (block.type !== "tool_use") continue;
          const result = await this.runTool(block);
          results.push(result);
          this.opts.onMessage(toolResultMessage(result.tool_use_id, result.content, result.is_error === true));
        }
```

(Import `toolResultMessage` alongside the existing helpers from `./messages.js`.)

`src/ui/transcript.ts` — add to `DisplayItem`:

```ts
  | { kind: "toolResult"; text: string; extra: number; isError: boolean }
```

Add the preview helper and the `toDisplayItems` branch (before the `result` branch):

```ts
function toolResultPreview(content: unknown): { text: string; extra: number } {
  const s =
    typeof content === "string" ? content
    : Array.isArray(content)
      ? content.map(b => (typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n")
    : content == null ? ""
    : JSON.stringify(content);
  const lines = s.split("\n").filter(l => l.trim() !== "");
  if (lines.length === 0) return { text: "(no output)", extra: 0 };
  return { text: lines[0].trim(), extra: lines.length - 1 };
}
```

```ts
  if (m.type === "tool_result") {
    const preview = toolResultPreview(m.content);
    return [{ kind: "toolResult", text: preview.text, extra: preview.extra, isError: m.is_error === true }];
  }
```

`src/ui/layout.ts` — add the case to `layoutItem` (before `result`):

```ts
    case "toolResult": {
      const suffix = item.extra > 0 ? ` (+${item.extra} lines)` : "";
      const line = truncateToWidth(`  ⎿ ${item.text}${suffix}`, Math.max(1, width));
      return [colorize(line, item.isError ? theme.error : theme.muted)];
    }
```

(Import `truncateToWidth` from `./width.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/toolResult.test.ts tests/messageList.test.tsx tests/session-integration.test.ts`
Expected: PASS. `nativeApp.ts` needs no change: `handleMessage` already routes every mapped item through `buffer.append`, and `toolResult` is not a `SPACED_KINDS` member so it stays visually attached to its tool label.

- [ ] **Step 5: Commit**

```bash
git add src/engine/messages.ts src/engine/loop.ts src/ui/transcript.ts src/ui/layout.ts tests/toolResult.test.ts
git commit -m "feat(ui): show tool result previews under tool labels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Real LCS line diffs (`src/ui/transcript.ts`)

**Files:**
- Modify: `src/ui/transcript.ts` (`diffLines`)
- Test: `tests/diff.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `diffLines(name, input, cap = 20): DiffLine[]` — same signature; for `Edit` it now returns an LCS diff with context lines collapsed (max 2 context lines around each change, `…` marker for collapsed runs). `Write` behavior (all `+`) unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/diff.test.ts
import { describe, it, expect } from "vitest";
import { diffLines } from "../src/ui/transcript.js";

describe("Edit line diff", () => {
  it("shows only changed lines with context, not full old+new dumps", () => {
    const oldS = ["a", "b", "c", "d", "e"].join("\n");
    const newS = ["a", "b", "X", "d", "e"].join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines).toEqual([
      { sign: " ", text: "a" },
      { sign: " ", text: "b" },
      { sign: "-", text: "c" },
      { sign: "+", text: "X" },
      { sign: " ", text: "d" },
      { sign: " ", text: "e" }
    ]);
  });
  it("collapses long unchanged runs to 2 context lines each side", () => {
    const mid = Array.from({ length: 10 }, (_, i) => `same${i}`);
    const oldS = ["start", ...mid, "old-end"].join("\n");
    const newS = ["start", ...mid, "new-end"].join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines.some(l => l.sign === " " && l.text === "…")).toBe(true);
    // Only 2 context lines survive right before the change.
    const changeIdx = lines.findIndex(l => l.sign === "-");
    expect(lines[changeIdx - 1]).toEqual({ sign: " ", text: "same9" });
    expect(lines[changeIdx - 2]).toEqual({ sign: " ", text: "same8" });
    expect(lines[changeIdx - 3]).toEqual({ sign: " ", text: "…" });
  });
  it("keeps the Write all-additions behavior", () => {
    const lines = diffLines("Write", { content: "a\nb" });
    expect(lines).toEqual([
      { sign: "+", text: "a" },
      { sign: "+", text: "b" }
    ]);
  });
  it("keeps the row cap with overflow marker", () => {
    const oldS = Array.from({ length: 30 }, (_, i) => `o${i}`).join("\n");
    const newS = Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n");
    const lines = diffLines("Edit", { old_string: oldS, new_string: newS });
    expect(lines.length).toBe(21);
    expect(lines[20].text).toMatch(/more/);
  });
  it("falls back to the dump format when strings are missing", () => {
    const lines = diffLines("Edit", { new_string: "x" });
    expect(lines).toEqual([{ sign: "+", text: "x" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/diff.test.ts`
Expected: FAIL — current implementation emits all `-` lines then all `+` lines.

- [ ] **Step 3: Implement in `src/ui/transcript.ts`**

Add above `diffLines`:

```ts
// Classic LCS table walk producing a unified-style line diff.
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { out.push({ sign: " ", text: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ sign: "-", text: oldLines[i++] });
    else out.push({ sign: "+", text: newLines[j++] });
  }
  while (i < m) out.push({ sign: "-", text: oldLines[i++] });
  while (j < n) out.push({ sign: "+", text: newLines[j++] });
  return out;
}

// Collapse unchanged runs longer than 2*ctx+1 to ctx lines on each side with
// a "…" marker between; leading/trailing runs keep only ctx lines.
function collapseContext(lines: DiffLine[], ctx = 2): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (leading: boolean, trailing: boolean) => {
    if (run.length === 0) return;
    const limit = ctx;
    if (leading) {
      if (run.length > limit) out.push({ sign: " ", text: "…" }, ...run.slice(run.length - limit));
      else out.push(...run);
    } else if (trailing) {
      out.push(...run.slice(0, limit));
      if (run.length > limit) out.push({ sign: " ", text: "…" });
    } else if (run.length > 2 * limit + 1) {
      out.push(...run.slice(0, limit), { sign: " ", text: "…" }, ...run.slice(run.length - limit));
    } else {
      out.push(...run);
    }
    run = [];
  };
  let seenChange = false;
  for (const l of lines) {
    if (l.sign === " ") { run.push(l); continue; }
    flush(!seenChange, false);
    seenChange = true;
    out.push(l);
  }
  flush(false, true);
  return out;
}
```

Replace the `Edit` branch of `diffLines`:

```ts
  if (name === "Edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (oldStr !== "" && newStr !== "") {
      lines.push(...collapseContext(lcsDiff(oldStr.split("\n"), newStr.split("\n"))));
    } else {
      // Fallback: pure insertion or deletion keeps the simple dump format.
      if (oldStr !== "") for (const l of oldStr.split("\n")) lines.push({ sign: "-", text: l });
      if (newStr !== "") for (const l of newStr.split("\n")) lines.push({ sign: "+", text: l });
    }
  } else if (name === "Write") {
```

(The trailing cap logic with `… (+N more)` stays exactly as it is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/diff.test.ts tests/messageList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/transcript.ts tests/diff.test.ts
git commit -m "feat(ui): render Edit tool input as a real LCS line diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Paste fallback without bracketed paste (`src/ui/input.ts`)

**Files:**
- Modify: `src/ui/input.ts` (`KeyDecoder.feed` + new exported helper)
- Test: `tests/paste-coalesce.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `coalescePaste(keys: Key[]): Key[]` (exported for tests); `KeyDecoder.feed` applies it per chunk. Bracketed paste, single keystrokes, and escape sequences are unaffected.

- [ ] **Step 1: Write the failing test**

```ts
// tests/paste-coalesce.test.ts
import { describe, it, expect } from "vitest";
import { KeyDecoder, coalescePaste, type Key } from "../src/ui/input.js";

function feed(dec: KeyDecoder, s: string): Key[] {
  return dec.feed(Buffer.from(s, "utf8"));
}

describe("paste coalescing without bracketed paste (legacy conhost)", () => {
  it("coalesces a multi-line burst in one chunk into a single paste key", () => {
    const keys = feed(new KeyDecoder(), "line one\r\nline two\r\nline three");
    expect(keys).toEqual([{ t: "paste", text: "line one\nline two\nline three" }]);
  });
  it("coalesces a single-line burst (multiple printables) into a paste", () => {
    const keys = feed(new KeyDecoder(), "hello");
    expect(keys).toEqual([{ t: "paste", text: "hello" }]);
  });
  it("leaves a single keystroke alone", () => {
    expect(feed(new KeyDecoder(), "a")).toEqual([{ t: "printable", ch: "a" }]);
    expect(feed(new KeyDecoder(), "\r")).toEqual([{ t: "enter" }]);
  });
  it("leaves a single CJK character (IME input) alone", () => {
    expect(feed(new KeyDecoder(), "中")).toEqual([{ t: "printable", ch: "中" }]);
  });
  it("does not coalesce chunks containing escape sequences", () => {
    const keys = feed(new KeyDecoder(), "\x1b[Aab");
    expect(keys[0]).toEqual({ t: "up" });
    expect(keys.slice(1)).toEqual([{ t: "printable", ch: "a" }, { t: "printable", ch: "b" }]);
  });
  it("keeps bracketed paste working as before", () => {
    const keys = feed(new KeyDecoder(), "\x1b[200~pasted\r\ntext\x1b[201~");
    expect(keys).toEqual([{ t: "paste", text: "pasted\r\ntext" }]);
  });
  it("converts CR, LF and CRLF inside a burst to \\n and tabs to \\t", () => {
    const keys = feed(new KeyDecoder(), "a\rb\nc\td");
    expect(keys).toEqual([{ t: "paste", text: "a\nb\nc\td" }]);
  });
});

describe("coalescePaste unit", () => {
  it("returns keys unchanged when any key is not printable/enter/tab", () => {
    const keys: Key[] = [{ t: "printable", ch: "a" }, { t: "backspace" }];
    expect(coalescePaste(keys)).toBe(keys);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/paste-coalesce.test.ts`
Expected: FAIL — bursts are replayed as individual keys.

- [ ] **Step 3: Implement in `src/ui/input.ts`**

Note on CRLF: the existing decoder maps `\r` and `\n` each to `enter`, so a CRLF paste becomes two `enter` keys. To coalesce CRLF into a single `\n`, the decoder must not double-count: change the plain-char branch to swallow a `\n` that immediately follows a `\r`:

Replace the `\r`/`\n` line in `tryConsumeOne`:

```ts
    if (ch === "\r") {
      // Swallow the LF of a CRLF pair so pastes don't produce double enters.
      keys.push({ t: "enter" });
      return s[1] === "\n" ? 2 : 1;
    }
    if (ch === "\n") { keys.push({ t: "enter" }); return 1; }
```

Add the exported helper (module scope, below the `Key` type):

```ts
/**
 * Fallback paste detection for terminals without bracketed paste (legacy
 * conhost: classic cmd.exe / powershell.exe windows). A human cannot produce
 * multiple keys in a single stdin read — keyboard auto-repeat delivers one
 * char per chunk — so a chunk that decodes to 2+ keys consisting solely of
 * printable characters, Enter and Tab is a paste. Coalescing it prevents
 * each pasted newline from submitting a message. Chunks containing any other
 * key (escape sequences, ctrl chords) are left untouched.
 */
export function coalescePaste(keys: Key[]): Key[] {
  if (keys.length < 2) return keys;
  let text = "";
  for (const k of keys) {
    if (k.t === "printable") text += k.ch;
    else if (k.t === "enter") text += "\n";
    else if (k.t === "tab") text += "\t";
    else return keys;
  }
  return [{ t: "paste", text }];
}
```

Apply it in `feed`:

```ts
  feed(chunk: Buffer): Key[] {
    this.clearTimer();
    this.pending += this.utf8.write(chunk);
    return coalescePaste(this.drain());
  }
```

(The `onTimeout` path emits only `esc` and needs no coalescing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/paste-coalesce.test.ts tests/inputBox.test.tsx tests/terminal.test.ts`
Expected: PASS. If an existing decoder test feeds multi-char bursts and expects individual keys, update it to expect the coalesced paste (that is the new intended behavior).

- [ ] **Step 5: Commit**

```bash
git add src/ui/input.ts tests/paste-coalesce.test.ts
git commit -m "fix(input): coalesce key bursts into paste on terminals without bracketed paste

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9a: Fix blank-line burst on footer growth (`src/ui/term/render.ts`)

**Context:** Discovered during Task 9 manual verification (screenshot showed dozens of blank lines between a tool call and the following response). Root cause, confirmed by direct reproduction: `InlineRenderer.frame()`'s footer-growth "evacuate" path (`src/ui/term/render.ts:85-91`) always scrolls the *entire* old scroll region up by `lastScrollBottom - scrollBottom` rows via `"\r\n".repeat(evacuate)`, to relocate on-screen transcript content into the new, smaller region. When little content has actually been committed yet (common early in a response, e.g. right after a tool call, when the region was still tall from an idle-sized footer), most of the region being scrolled is blank, unpainted screen space — so the scroll bakes a large, highly visible burst of blank lines into native scrollback. This is a pre-existing bug in a file the rest of this plan doesn't touch, but it's squarely a "message display" defect, so it's fixed here as an addendum.

**Files:**
- Modify: `src/ui/term/render.ts`
- Modify: `tests/render.test.ts` (one existing test asserts the buggy behavior and must be updated)

**Interfaces:**
- No signature changes to `InlineRenderer` (`frame`, `invalidate`, `finalize` unchanged).
- Adds two private fields: `printedRows: number` (cumulative count of transcript rows actually printed since the region was last invalidated) and `recentRows: string[]` (a bounded cache of the most recently printed row strings, capped at 1000).

**Design:** When the footer grows (region must shrink), only fall back to the lossy scroll-relocation ("evacuate") when there is more on-screen content than the new region can hold — in that case scrolling is the only way to preserve the excess in native scrollback, so it's kept as-is. When all currently-visible content fits inside the new, smaller region, skip scrolling entirely: clear the viewport (`0J`, which never touches scrollback) and redraw the last `onScreen` cached rows directly at the new region's bottom-anchored position via absolute cursor addressing. This produces the identical end visual state with zero blank lines pushed into scrollback.

- [ ] **Step 1: Update the existing test that encodes the old (buggy) behavior**

Read `tests/render.test.ts`'s `"growing footer height evacuates newly-reclaimed rows into scrollback before shrinking the region"` test (around line 115-127). It calls `r.frame(buf, ...)` twice with an **empty** `Buffer` (nothing ever committed) and asserts a `\r\n` evacuation burst happens. Under the fix, zero committed content always takes the fast "fits" path (no scrolling needed since `onScreen = 0 <= scrollBottom` is trivially true), so this assertion becomes wrong by design. Replace it with:

```ts
  it("growing footer height with no content on screen redraws without scrolling (no blank-line burst)", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // First frame: footer is 4 lines, scrollBottom = 20.
    r.frame(buf, baseBottom(), theme, size);
    // Second frame: streaming adds a work-indicator line, footer becomes 5 lines, scrollBottom = 19.
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // No content was ever committed, so nothing needs to be scrolled into
    // scrollback: the old evacuate burst (`\x1b[20;1H\r\n`) must not appear.
    expect(second).not.toContain(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    expect(second).toContain(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
  });

  it("growing footer height with more on-screen content than the new region holds still evacuates the excess into scrollback", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    // Commit enough rows to fill the entire first scroll region (20 rows),
    // so all of it is "on screen" and none of it can fit once the region
    // shrinks by 1 row on the second frame.
    for (let i = 0; i < SCROLL_BOTTOM; i++) buf.append({ kind: "notice", text: `row ${i}` });
    r.frame(buf, baseBottom(), theme, size);
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size);
    // More content is on screen (20 rows) than the new region can hold (19
    // rows), so the excess row must still be evacuated via a real scroll.
    const evacuateIdx = second.indexOf(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    const newRegionIdx = second.indexOf(`\x1b[1;${SCROLL_BOTTOM - 1}r`);
    expect(evacuateIdx).toBeGreaterThanOrEqual(0);
    expect(newRegionIdx).toBeGreaterThan(evacuateIdx);
  });

  it("growing footer height with partial on-screen content (fits new region) redraws it at the new bottom-anchored position, not via scrolling", () => {
    const r = new InlineRenderer();
    const buf = new Buffer();
    buf.append({ kind: "notice", text: "ONLY_ROW" });
    r.frame(buf, baseBottom(), theme, size); // commits "ONLY_ROW", scrollBottom = 20
    const second = r.frame(buf, baseBottom({ streaming: true, activeTool: "Bash" }), theme, size); // scrollBottom = 19
    // 1 row of real content fits easily inside a 19-row region: redrawn
    // directly, no scroll burst, and it must still be present on screen.
    expect(second).not.toContain(`\x1b[${SCROLL_BOTTOM};1H\r\n`);
    expect(second).toContain("ONLY_ROW");
  });
```

- [ ] **Step 2: Run the updated/new tests to verify they fail against the current implementation**

Run: `npx vitest run tests/render.test.ts`
Expected: the two new tests FAIL (current code always evacuates via scrolling, so "no blank-line burst" and "redrawn directly" assertions don't hold); the updated first test also fails for the same reason it was rewritten.

- [ ] **Step 3: Implement the fix in `src/ui/term/render.ts`**

Add two private fields to the class, right after the existing three:

```ts
  private lastScrollBottom = -1;
  private lastRows = -1;
  private lastColumns = -1;
  // Cumulative count of transcript rows printed since the region was last
  // invalidated, and a bounded cache of their text, used to redraw
  // currently-visible content directly (no terminal scrolling) when the
  // footer grows and everything on screen still fits the new, smaller
  // region -- see the shrink branch in frame() below.
  private printedRows = 0;
  private recentRows: string[] = [];
  private static readonly RECENT_ROWS_CAP = 1000;
```

Replace the evacuate block (current lines 85-91) with:

```ts
    if (!firstFrame && !sizeChanged && scrollBottom < this.lastScrollBottom) {
      const onScreen = Math.min(this.printedRows, this.lastScrollBottom);
      if (onScreen <= scrollBottom) {
        // Every row of transcript content currently on screen fits inside
        // the new, smaller region: redraw it directly at its new
        // bottom-anchored position via absolute cursor addressing instead
        // of relocating it with a terminal scroll. Scrolling to reposition
        // content unavoidably scrolls everything *between* the content and
        // the old region's top edge too -- and when the region was mostly
        // blank (little committed yet, common early in a response), that
        // blank filler gets pushed into native scrollback as a large,
        // highly visible burst of empty lines. A direct redraw has no such
        // side effect and produces the identical end visual state.
        out += cursorTo(1, 1) + ERASE_DOWN;
        if (onScreen > 0) {
          const tail = this.recentRows.slice(-onScreen);
          out += cursorTo(scrollBottom - onScreen + 1, 1) + tail.join("\r\n") + "\r\n";
        }
      } else {
        // More content is currently visible than the new region can hold:
        // the excess rows have never been scrolled into native scrollback
        // (they've only ever been drawn on screen), so they must be
        // relocated via a real scroll -- there is no way to preserve them
        // in scrollback other than actually scrolling the terminal.
        const evacuate = this.lastScrollBottom - scrollBottom;
        out += cursorTo(this.lastScrollBottom, 1) + "\r\n".repeat(evacuate);
      }
    }
```

Update the tracking at the bottom of `frame()` (current lines 105-106) to accumulate the new fields:

```ts
    const staticRows = buffer.takeCommitRows(columns, theme);
    if (staticRows.length > 0) {
      this.printedRows += staticRows.length;
      this.recentRows.push(...staticRows);
      if (this.recentRows.length > InlineRenderer.RECENT_ROWS_CAP) {
        this.recentRows = this.recentRows.slice(-InlineRenderer.RECENT_ROWS_CAP);
      }
    }
    out += cursorTo(scrollBottom, 1) + staticRows.map(r => r + "\r\n").join("");
```

(The line after it, `out += cursorTo(scrollBottom + 1, 1) + ERASE_DOWN + footer.join("\r\n");`, is unchanged.)

Update `invalidate()` and `finalize()` to also reset the new fields:

```ts
  invalidate(): void {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    this.printedRows = 0;
    this.recentRows = [];
  }

  finalize(): string {
    this.lastScrollBottom = -1;
    this.lastRows = -1;
    this.lastColumns = -1;
    this.printedRows = 0;
    this.recentRows = [];
    return RESET_SCROLL_REGION + "\r\n";
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/render.test.ts`
Expected: all tests PASS, including the two new ones and the rewritten one. All other pre-existing tests in the file (scroll region definition, committed-once semantics, footer painting, overlay rendering, streaming caps, shrink-blanking, invalidate/finalize, width-wrapping, thinking-text styling) must still pass unchanged.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run` — must match the pre-existing baseline failure count exactly (8 unrelated failures in `tests/skills.test.ts`/`tests/app.test.tsx`), no new failures.
Run: `npx tsc --noEmit -p tsconfig.json` — must be clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/term/render.ts tests/render.test.ts
git commit -m "fix(ui): stop scrolling blank filler into scrollback when the footer grows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Full suite, build, and manual verification

**Files:**
- No new files; fixes only if the suite or manual run reveals regressions.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. Fix any regression before proceeding (each fix gets its own commit).

- [ ] **Step 2: Build**

Run: `npm run build` (check `package.json` scripts for the exact name; fall back to `npx tsc -p tsconfig.json`).
Expected: clean compile.

- [ ] **Step 3: Manual verification (Windows Terminal AND legacy conhost)**

In Windows Terminal and in a classic conhost window (`conhost.exe` then run the CLI):
1. Send a Chinese prompt (e.g. `請用三句話介紹這個專案`) — streamed CJK text must not corrupt the footer; committed transcript wraps cleanly.
2. Ask for a file edit — tool label, LCS diff, and `⎿` result preview appear as one tight group with a blank line before the next assistant block.
3. Paste a multi-line text into the input box in conhost — it must land in the input as one block, not submit line by line.
4. Resize the window during and after streaming — transcript reprints cleanly.

- [ ] **Step 4: Commit any fixes; no commit needed if clean**
