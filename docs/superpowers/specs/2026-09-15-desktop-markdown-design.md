# Design: desktop assistant markdown rendering

Date: 2026-09-15
Status: approved (user chose option A: marked + DOMPurify)

## 1. Purpose

Assistant bubbles in the desktop app currently render raw markdown source
(`src/desktop/renderer/chatPane.tsx:479-481`, `<pre>{message.text}</pre>`),
so `**bold**`, fenced code blocks, and tables are hard to read. This spec
makes assistant replies readable with full markdown rendering while leaving
user, notice, and error bubbles as plain text.

User decisions:
- Scope: only `role === "assistant"` renders markdown.
- Feature set: full GFM (headings, bold/italic, lists, fenced code, tables,
  blockquotes, links, task lists).
- Code blocks: language label + copy button in v1. Code is styled as a
  single-color block (background + mono font, no per-token colors); a real
  token highlighter (e.g. `highlight.js`) is a phase-2 upgrade behind the
  same code-renderer hook.

## 2. Background / current behavior

- Renderer (`src/desktop/renderer/chatPane.tsx:477-483`): every message maps
  to `<article class="bubble {role}"><pre>{text}</pre></article>`. No markdown
  parsing exists in the desktop bundle.
- TUI (`src/ui/markdown.ts`) uses `marked` with custom block/inline/table
  renderers plus `cli-highlight`. `cli-highlight` pulls node/chalk and cannot
  be imported into the Vite renderer bundle (same reason `buildRegistry` is
  banned there; see `chatPane.tsx:31-35`).
- `marked@^15.0.12` is already a production dependency, so the renderer can
  reuse it with no new parse dependency. `style.css` has only `.bubble pre`
  rules today; no `.md-*` classes exist.
- Streaming appends plain text via `text_delta` into the same bubble, so the
  renderer must tolerate unclosed fences mid-stream.

## 3. Approaches considered

- A (chosen): `marked` (already present) + `dompurify` (one small new dep)
  to sanitized HTML via `dangerouslySetInnerHTML`. Custom code renderer emits
  a header (language + copy button); click handling via container-level event
  delegation to `navigator.clipboard`. Streaming safety by appending a closing
  fence for display only when the fence count is odd.
- B (rejected): `react-markdown` + `remark-gfm` + `rehype-highlight`. Most
  React-idiomatic and safe by default, but adds 3-4 dependencies and the
  largest bundle; still needs the same partial-fence handling.
- C (rejected): zero-new-dep hand-rolled React renderer over
  `marked.lexer` tokens. Smallest bundle and secure by construction, but the
  most dev cost (tables, nested lists, edge cases) and the weakest highlight.

## 4. Detailed design

### 4.1 Modules

- New `src/desktop/renderer/markdown.ts` (pure, node-importable for tests):
  exports `renderAssistantHtml(text: string): string`. Steps: (1) close an
  unclosed fence for display only (count ``` occurrences; append `\n``` ``` if
  odd); (2) `marked.parse` with `breaks: true` and a custom `renderer.code`
  that emits `<div class="md-code"><div class="md-code-head"><span>lang</span>
  <button data-code="...">Copy</button></div><pre><code class="language-x">...
  </code></pre></div>` (code HTML-escaped before embedding; the `data-code`
  attribute carries the raw code base64-encoded, so quotes, angle brackets,
  and newlines never break the attribute); (3) links get
  `target="_blank" rel="noopener"`. On any throw, the caller falls back to
  plain `<pre>`.
- New `src/desktop/renderer/Markdown.tsx` (thin wrapper): props `{ text }`;
  memoizes `DOMPurify.sanitize(renderAssistantHtml(text))` (with `button`
  and the `data-code` attribute allowlisted so the sanitizer keeps the copy
  button), renders `<div class="md-body" dangerouslySetInnerHTML>`, and
  handles clicks: when a `button[data-code]` is clicked, base64-decode its
  payload, `await
  navigator.clipboard.writeText`, swap label to `Copied` for 1.5s (then back
  to `Copy`), show `Failed` on error with `execCommand` fallback. Both files
  stay far under the `lint:size` ceiling.

### 4.2 ChatPane integration

- `chatPane.tsx` message list: `message.role === "assistant" ? <Markdown
  text={message.text}/> : <pre>{message.text}</pre>`. Message state keeps
  storing plain text; conversion is render-time only, so history replay,
  `mergeAssistantFinal`, and background-session filtering are untouched.
- While a turn is pending and its last block is unclosed, the copy button for
  that block is disabled (avoids copying a half-streamed snippet).

### 4.3 Styling

- Append `.bubble.assistant .md-*` rules to
  `src/desktop/renderer/style.css` using existing `var(--gui-*)` tokens so
  dark/light themes follow automatically: heading scale, paragraph spacing,
  `ul/ol` indent, inline-code pill, code-block background
  `var(--gui-bg)` + mono font, table borders + header row, blockquote left
  border, link accent color, task-list checkbox alignment.

### 4.4 Error handling

- Parse/sanitize throw: render plain `<pre>` instead; never blank the bubble.
- `DOMPurify` config: forbid `on*` handlers and `form` elements; strip
  `<script>/<style>/<iframe>` (default plus explicit hooks).
- Clipboard denial: button shows `Failed`, no exception propagates; focus
  stays where it was.

### 4.5 Testing

- New `tests/desktop-markdown.test.ts`: fence auto-close helper; code header
  contains language + copy button; `<script>`/`onerror` stripped after
  sanitize; table/quote/list render; parse failure falls back to `<pre>`;
  copy payload round-trips raw code.
- Existing `desktop-assistant-dedup`, `commands-desktop`, and `packaging`
  suites unaffected. Gates: `npm run typecheck:desktop`, `npm run lint`,
  `npm run lint:size` green.

### 4.6 Files to touch

- New: `src/desktop/renderer/markdown.ts`, `src/desktop/renderer/Markdown.tsx`,
  `tests/desktop-markdown.test.ts`, this spec.
- Edit: `src/desktop/renderer/chatPane.tsx` (one render branch),
  `src/desktop/renderer/style.css` (append `.md-*` block), `package.json` +
  `package-lock.json` (add `dompurify` + `@types/dompurify`).

## 5. Out of scope

- No changes to user/notice/error bubbles, TUI markdown, backend, or IPC.
- No full syntax-token highlighter in v1 (phase 2 may add `highlight.js` or
  equivalent behind the same code-renderer hook).
- No raw-HTML passthrough from LLM output (always sanitized).
- No streaming-token diffing or per-token animation.

## 6. Acceptance criteria

1. Assistant replies render headings, bold/italic, lists, code blocks,
   tables, quotes, links, and task lists instead of raw source.
2. Each fenced block shows its language and a Copy button that copies the
   raw code.
3. User/notice/error bubbles remain plain `<pre>` text.
4. Mid-stream (unclosed fence) renders without swallowing following text.
5. Malicious `<script>`/`onerror` payloads never execute.
6. Tests in 4.5 pass; `typecheck:desktop`, `lint`, and `lint:size` green.
