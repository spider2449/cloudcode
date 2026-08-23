import TurndownService from "turndown";

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});
// Turndown copies unknown elements' text through by default, which would leak
// script bodies and CSS into the model's context as garbage text.
service.remove(["script", "style", "noscript"]);

export function htmlToMarkdown(html: string): string {
  return service.turndown(html);
}
