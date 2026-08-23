import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../src/engine/tools/htmlToMarkdown.js";

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    expect(htmlToMarkdown("<h1>Title</h1><p>Hello world</p>"))
      .toContain("# Title");
    expect(htmlToMarkdown("<h1>Title</h1><p>Hello world</p>"))
      .toContain("Hello world");
  });
  it("keeps links", () => {
    expect(htmlToMarkdown('<p>see <a href="/next">the docs</a></p>'))
      .toContain("[the docs](/next)");
  });
  it("drops script and style contents entirely", () => {
    const out = htmlToMarkdown("<style>p { color: red }</style><script>alert(1)</script><p>text</p>");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("color: red");
    expect(out).toContain("text");
  });
  it("converts fenced code blocks", () => {
    const out = htmlToMarkdown("<pre><code>npm run dev</code></pre>");
    expect(out).toContain("```");
    expect(out).toContain("npm run dev");
  });
  it("flattens lists", () => {
    const out = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });
});
