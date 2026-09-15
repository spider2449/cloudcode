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
