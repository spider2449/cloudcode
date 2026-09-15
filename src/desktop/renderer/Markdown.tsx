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
