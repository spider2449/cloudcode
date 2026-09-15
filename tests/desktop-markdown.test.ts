import { describe, expect, it } from "vitest";
import {
  closeUnclosedFence,
  encodeCode,
  escapeHtml,
  renderAssistantHtml,
} from "../src/desktop/renderer/markdown.js";

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
