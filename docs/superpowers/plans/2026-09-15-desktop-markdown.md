# Desktop Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant bubbles in the desktop app as sanitized markdown HTML with copyable code blocks.

**Architecture:** A pure, node-importable `markdown.ts` (fence-closing, `marked` parse with custom code/link/html/checkbox renderers) feeds a thin `Markdown.tsx` wrapper (DOMPurify sanitize + click-to-copy delegation); `chatPane.tsx` switches only `role === "assistant"` to the new component; styles append to `style.css`.

**Tech Stack:** TypeScript, React 19 (Vite renderer bundle), `marked@^15` (already a dependency), `dompurify` (one new dependency) + `@types/dompurify` (dev), vitest (node environment).

---

## File structure

- Create `src/desktop/renderer/markdown.ts` — pure helpers, no DOM: `escapeHtml`, `encodeCode` (base64 of UTF-8 bytes, no `Buffer` import so the Vite bundle stays browser-safe), `closeUnclosedFence`, `isSafeHref`, `renderAssistantHtml`. Importable from node tests.
- Create `src/desktop/renderer/Markdown.tsx` — thin wrapper: `DOMPurify.sanitize(renderAssistantHtml(text))` memoized, renders `div.md-body` via `dangerouslySetInnerHTML`, handles `button[data-code]` clicks with `navigator.clipboard` + `execCommand` fallback.
- Modify `src/desktop/renderer/chatPane.tsx` — add the `Markdown` import; render `<Markdown text={...}/>` only for `role === "assistant"`, keep `<pre>` for user/notice/error.
- Modify `src/desktop/renderer/style.css` — append `.bubble.assistant .md-*` rules using existing `var(--gui-*)` tokens.
- Create `tests/desktop-markdown.test.ts` — unit tests for `markdown.ts` only (vitest runs in node env, so DOMPurify/the wrapper are verified by `typecheck:desktop` + manual desktop run instead).
- Modify `package.json` + `package-lock.json` — add `dompurify` dependency and `@types/dompurify` devDependency.

---

### Task 1: Pure markdown renderer with tests

**Files:**
- Create: `src/desktop/renderer/markdown.ts`
- Test: `tests/desktop-markdown.test.ts`

- [ ] **Step 1: Write the failing test for fence closing and escaping**

```ts
import { describe, expect, it } from "vitest";
import { closeUnclosedFence, encodeCode, escapeHtml } from "../src/desktop/renderer/markdown.js";

describe("closeUnclosedFence", () => {
  it("appends a closing fence when the count is odd", () => {
    expect(closeUnclosedFence("hi\n```ts\nconst a = 1;")).toBe("hi\n```ts\nconst a = 1;\n```");
  });

  it("leaves balanced fences alone", () => {
    const src = "a\n```js\nx();\n```\nb";
    expect(closeUnclosedFence(src)).toBe(src);
  });

  it("leaves fence-free text alone", () => {
    expect(closeUnclosedFence("plain **bold**")).toBe("plain **bold**");
  });
});

describe("escapeHtml", () => {
  it("escapes tag characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("encodeCode", () => {
  it("round-trips UTF-8 through base64", () => {
    const raw = "const s = \"你好 <world>\";";
    const bytes = Uint8Array.from(atob(encodeCode(raw)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(raw);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/desktop-markdown.test.ts`
Expected: FAIL with "Failed to resolve import" (module does not exist yet).

- [ ] **Step 3: Write the minimal pure module**

```ts
import { Marked } from "marked";
import type { Tokens } from "marked";

// Base64 of UTF-8 bytes without importing node:buffer, so this module stays
// importable from both the Vite renderer bundle and node-based unit tests.
export function encodeCode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Streaming guard: an odd number of ``` fence lines means the last block is
// still open mid-stream. Appending a closing fence for display only keeps the
// rest of the message rendering normally. The stored message text is untouched.
export function closeUnclosedFence(text: string): string {
  const fences = text.match(/^```/gm);
  const count = fences === null ? 0 : fences.length;
  return count % 2 === 1 ? text + "\n```" : text;
}

// Defense in depth behind DOMPurify: unsafe link targets never become anchors.
export function isSafeHref(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return (
    !lower.startsWith("javascript:") && !lower.startsWith("data:") && !lower.startsWith("vbscript:")
  );
}

export function renderAssistantHtml(text: string): string {
  try {
    const md = new Marked({ gfm: true, breaks: true });
    md.use({
      renderer: {
        code({ text: code, lang }: Tokens.Code): string {
          const raw = code.replace(/\n$/, "");
          const safeLang = (lang ?? "").trim().split(/\s+/)[0] ?? "";
          const label = safeLang === "" ? "code" : safeLang;
          const langClass = safeLang === "" ? "" : ` class="language-${escapeHtml(safeLang)}"`;
          return (
            `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(label)}</span>` +
            `<button type="button" data-code="${encodeCode(raw)}">Copy</button></div>` +
            `<pre><code${langClass}>${escapeHtml(raw)}</code></pre></div>`
          );
        },
        link({ href, title, tokens }: Tokens.Link): string {
          const inner = this.parser.parseInline(tokens);
          const target = href ?? "";
          if (!isSafeHref(target)) return inner;
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
          return `<a href="${escapeHtml(target)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
        },
        image({ href, text: alt }: Tokens.Image): string {
          const target = href ?? "";
          if (!isSafeHref(target)) return escapeHtml(alt);
          return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener">[${escapeHtml(alt)}]</a>`;
        },
        checkbox({ checked }: Tokens.Checkbox): string {
          // Render task state as text (no <input> elements from LLM output).
          return checked ? "[x] " : "[ ] ";
        },
        html({ text: rawHtml }: Tokens.HTML | Tokens.Tag): string {
          // Never pass LLM-sourced raw HTML through; keep the inner text only.
          return escapeHtml(rawHtml.replace(/<[^>]*>/g, ""));
        },
      },
    });
    return md.parse(closeUnclosedFence(text), { async: false }) as string;
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/desktop-markdown.test.ts`
Expected: PASS (4 tests: 3 fence + 1 escape + 1 base64 = 5 tests pass).

- [ ] **Step 5: Append the render-behavior tests**

Append to `tests/desktop-markdown.test.ts`:

```ts
import { renderAssistantHtml } from "../src/desktop/renderer/markdown.js";

describe("renderAssistantHtml", () => {
  it("renders headings, emphasis, and inline code", () => {
    const html = renderAssistantHtml("# Title\n\nSome **bold**, *italic*, and `npm test` here.");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>npm test</code>");
  });

  it("wraps fenced code with a language label and copy payload", () => {
    const html = renderAssistantHtml("```ts\nconst a = 1;\n```");
    expect(html).toContain("md-code");
    expect(html).toContain("<span>ts</span>");
    expect(html).toContain(`data-code="${encodeCode("const a = 1;")}"`);
    expect(html).toContain("const a = 1;");
  });

  it("renders an unclosed fence without swallowing the message", () => {
    const html = renderAssistantHtml("intro\n```js\nconst a = 1;");
    expect(html).toContain("intro");
    expect(html).toContain("const a = 1;");
  });

  it("renders quotes, lists, tables, and task state", () => {
    const html = renderAssistantHtml(
      "> quoted\n\n- a\n- b\n\n| h1 | h2 |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo",
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("[x]");
    expect(html).toContain("todo");
  });

  it("strips raw HTML from LLM output", () => {
    const html = renderAssistantHtml(`hi <script>alert(1)</script> <b>there</b>`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("there");
  });

  it("drops javascript: links but keeps the text, and opens safe links in a new tab", () => {
    const evil = renderAssistantHtml("[click](javascript:alert(1))");
    expect(evil).not.toContain("javascript:");
    expect(evil).toContain("click");
    const safe = renderAssistantHtml("[docs](https://example.com)");
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener"');
  });
});
```

- [ ] **Step 6: Run the full test file**

Run: `npx vitest run tests/desktop-markdown.test.ts`
Expected: PASS (all 11 tests).

- [ ] **Step 7: Commit (with required patch version bump to 0.1.143)**

Repo rule: every commit bumps the patch version in all four places together (`tests/packaging.test.ts` fails otherwise). Apply `0.1.141 -> 0.1.143`? No — current version is `0.1.142` (the spec commit). Bump `0.1.142 -> 0.1.143` in:
- `src/version.ts` (`VERSION`)
- `package.json` (top-level `version`)
- `package-lock.json` (both `"version"` fields: line 3 and line 9)
- `installer/cloudcode.iss` (`#define AppVersion`)

```bash
git add src/desktop/renderer/markdown.ts tests/desktop-markdown.test.ts src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Add desktop markdown renderer pure module with tests (0.1.143)"
```

---

### Task 2: Markdown wrapper component with DOMPurify

**Files:**
- Modify: `package.json`, `package-lock.json` (new deps)
- Create: `src/desktop/renderer/Markdown.tsx`

- [ ] **Step 1: Install dompurify**

Run: `npm install dompurify`
Run: `npm install -D @types/dompurify`
Expected: `package.json` gains `"dompurify": "^3.x"` in dependencies and `"@types/dompurify"` in devDependencies; `npm ls dompurify` succeeds.

- [ ] **Step 2: Create the wrapper component**

```tsx
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { renderAssistantHtml } from "./markdown.js";

// Mirror of encodeCode in ./markdown.js (base64 of UTF-8 bytes).
function decodeCode(payload: string): string {
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function copyText(code: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    // The async clipboard API needs a secure context; fall back for older setups.
    const ta = document.createElement("textarea");
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

export function Markdown({ text }: { text: string }) {
  // data-code carries the raw snippet for the copy button; DOMPurify keeps
  // data-* attributes by default, listed here explicitly so a config change
  // can never silently drop the copy payload.
  const html = useMemo(
    () =>
      DOMPurify.sanitize(renderAssistantHtml(text), {
        ADD_TAGS: ["button"],
        ADD_ATTR: ["target", "rel", "type", "data-code"],
        FORBID_TAGS: ["form", "input", "style", "script", "iframe"],
      }),
    [text],
  );

  function onClick(event: React.MouseEvent<HTMLDivElement>) {
    const btn = (event.target as HTMLElement).closest?.("button[data-code]") as
      | HTMLButtonElement
      | null
      | undefined;
    if (btn === null || btn === undefined) return;
    let code: string;
    try {
      code = decodeCode(btn.getAttribute("data-code") ?? "");
    } catch {
      btn.textContent = "Failed";
      return;
    }
    void copyText(code).then((ok) => {
      btn.textContent = ok ? "Copied" : "Failed";
      window.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1500);
    });
  }

  return <div className="md-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
```

- [ ] **Step 3: Typecheck the renderer**

Run: `npm run typecheck:desktop`
Expected: clean (no errors). If `Tokens.Checkbox` does not exist in `marked@15`, replace that renderer param type with `{ checked }: { checked?: boolean }` in `markdown.ts` and rerun.

- [ ] **Step 4: Commit (bump 0.1.143 -> 0.1.144 in the same four files)**

```bash
git add src/desktop/renderer/Markdown.tsx package.json package-lock.json src/version.ts installer/cloudcode.iss
git commit -m "Add desktop Markdown wrapper with sanitize and copy (0.1.144)"
```

---

### Task 3: ChatPane integration and styles

**Files:**
- Modify: `src/desktop/renderer/chatPane.tsx` (import + one render branch)
- Modify: `src/desktop/renderer/style.css` (append `.md-*` block)

- [ ] **Step 1: Wire the Markdown component into chatPane.tsx**

Add after the `chatHelpers.js` import (line 29):

```tsx
import { Markdown } from "./Markdown.js";
```

Replace the message render block:

Old (`chatPane.tsx:478-482`):

```tsx
        {messages.map((message, index) => (
          <article key={`${message.id}-${message.role}-${index}`} className={`bubble ${message.role}`}>
            <pre>{message.text}</pre>
          </article>
        ))}
```

New:

```tsx
        {messages.map((message, index) => (
          <article key={`${message.id}-${message.role}-${index}`} className={`bubble ${message.role}`}>
            {message.role === "assistant" ? <Markdown text={message.text} /> : <pre>{message.text}</pre>}
          </article>
        ))}
```

Message state still stores plain text; conversion is render-time only, so history replay, `mergeAssistantFinal`, and background-session filtering are untouched.

- [ ] **Step 2: Append markdown styles to style.css**

Append at the end of `src/desktop/renderer/style.css`:

```css
.chat-list .bubble.assistant .md-body { font-size: 13px; line-height: 1.6; color: var(--gui-text, #d6d9df); overflow-wrap: anywhere; }
.chat-list .bubble.assistant .md-body > *:first-child { margin-top: 0; }
.chat-list .bubble.assistant .md-body > *:last-child { margin-bottom: 0; }
.chat-list .bubble.assistant .md-body h1 { font-size: 17px; margin: 10px 0 6px; }
.chat-list .bubble.assistant .md-body h2 { font-size: 15px; margin: 10px 0 6px; }
.chat-list .bubble.assistant .md-body h3, .chat-list .bubble.assistant .md-body h4 { font-size: 13px; margin: 8px 0 4px; }
.chat-list .bubble.assistant .md-body p { margin: 0 0 8px; }
.chat-list .bubble.assistant .md-body ul, .chat-list .bubble.assistant .md-body ol { margin: 0 0 8px; padding-left: 22px; }
.chat-list .bubble.assistant .md-body li { margin: 2px 0; }
.chat-list .bubble.assistant .md-body code { padding: 1px 5px; border-radius: 4px; background: var(--gui-element, #22252a); color: var(--gui-text, #e3ebf7); font: 12px ui-monospace, "Cascadia Code", monospace; }
.chat-list .bubble.assistant .md-body pre { margin: 8px 0; }
.chat-list .bubble.assistant .md-code { margin: 8px 0; border: 1px solid var(--gui-border-strong, #343840); border-radius: 7px; overflow: hidden; }
.chat-list .bubble.assistant .md-code-head { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: var(--gui-element, #22252a); color: var(--gui-muted, #9ba1ab); font-size: 11px; }
.chat-list .bubble.assistant .md-code-head button { padding: 2px 8px; border: 1px solid var(--gui-border-strong, #41454e); border-radius: 5px; background: transparent; color: inherit; font-size: 11px; cursor: pointer; }
.chat-list .bubble.assistant .md-code-head button:hover { color: var(--gui-text, #f0f2f5); background: var(--gui-hover, #292c32); }
.chat-list .bubble.assistant .md-code pre { margin: 0; padding: 8px; overflow-x: auto; background: var(--gui-bg, #111317); }
.chat-list .bubble.assistant .md-code pre code { padding: 0; background: transparent; white-space: pre; }
.chat-list .bubble.assistant .md-body table { margin: 8px 0; border-collapse: collapse; font-size: 12px; }
.chat-list .bubble.assistant .md-body th, .chat-list .bubble.assistant .md-body td { padding: 5px 9px; border: 1px solid var(--gui-border-strong, #343840); text-align: left; }
.chat-list .bubble.assistant .md-body th { background: var(--gui-element, #22252a); }
.chat-list .bubble.assistant .md-body blockquote { margin: 8px 0; padding: 6px 10px; border-left: 2px solid var(--gui-accent, #668bc7); background: var(--gui-element, #1d2025); color: var(--gui-muted, #aeb3bd); }
.chat-list .bubble.assistant .md-body a { color: var(--gui-accent, #7e98c3); }
.chat-list .bubble.assistant .md-body hr { margin: 10px 0; border: 0; border-top: 1px solid var(--gui-border, #2a2d33); }
```

- [ ] **Step 3: Run typecheck, lint, and size check**

Run: `npm run typecheck:desktop`
Expected: clean.

Run: `npm run lint`
Expected: clean (oxlint over `src` and `tests`).

Run: `npm run lint:size`
Expected: clean (new files ~120 and ~70 lines, far under the ~600-line warning).

- [ ] **Step 4: Run the desktop-related test suites**

Run: `npx vitest run tests/desktop-markdown.test.ts tests/desktop-assistant-dedup.test.ts tests/desktop-busySessions.test.ts tests/commands-desktop.test.ts tests/packaging.test.ts`
Expected: all PASS (packaging verifies the four version files agree).

- [ ] **Step 5: Commit (bump 0.1.144 -> 0.1.145 in the same four files)**

```bash
git add src/desktop/renderer/chatPane.tsx src/desktop/renderer/style.css src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "Render desktop assistant bubbles as markdown (0.1.145)"
```

---

### Task 4: Full verification and manual check

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all suites PASS.

- [ ] **Step 2: Build the desktop renderer**

Run: `npm run desktop:build`
Expected: build succeeds, `dist/renderer` emitted with no type errors.

- [ ] **Step 3: Manual verification in the desktop app**

Start the app (`npm run desktop:start`), send a message that returns markdown, and confirm each item (no commit for this step):
1. Headings, bold/italic, lists, and inline code render styled, not as source.
2. A fenced block shows its language label and a Copy button that copies the raw code.
3. A table and a blockquote render with borders/styling.
4. Mid-stream (while "Thinking"/streaming) the bubble never blanks or swallows text.
5. User/notice/error bubbles remain plain text.
6. Paste `<script>alert(1)</script>` or a `javascript:` link in an assistant reply replay — nothing executes.

---

## Self-review

1. **Spec coverage:** Purpose/scope (assistant-only, §1) → Task 3 Step 1. Full GFM set (§1) → Task 1 renderer + tests. Language label + copy button (§1, §4.1) → Task 1 code renderer + Task 2 delegation. No per-token highlight in v1 (§5, clarified during review) → no highlighter added; `language-*` class left as the phase-2 hook. Streaming fence-close (§4.1) → `closeUnclosedFence` + test. XSS (§4.4) → `html` stripping + `isSafeHref` + DOMPurify config + tests. Fallback to `<pre>` (§4.4) → internal catch in `renderAssistantHtml`. Checkbox-as-text (§4.4, no inputs) → `checkbox` renderer + `FORBID_TAGS` input. Tests (§4.5) → `tests/desktop-markdown.test.ts`. Files (§4.6) → exactly those files. Out of scope (§5) → untouched. Acceptance criteria (§6) → Task 4 manual checklist items 1-6.
2. **Placeholder scan:** no TBD/TODO; every code step shows complete file content; every command shows the exact invocation and expected output; version-bump steps name all four files and exact version numbers.
3. **Type consistency:** `renderAssistantHtml(text: string): string`, `encodeCode(s: string): string`, `escapeHtml(s: string): string`, `closeUnclosedFence(text: string): string`, `isSafeHref(href: string): boolean`, `Markdown({ text }: { text: string })`, `decodeCode(payload: string): string`, `copyText(code: string): Promise<boolean>` — signatures match across Tasks 1-3. CSS class names (`md-body`, `md-code`, `md-code-head`, `data-code`) match between the renderer, wrapper, and stylesheet.
