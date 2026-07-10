import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(markedTerminal());

export function renderMarkdown(text: string): string {
  try {
    const out = marked.parse(text, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
