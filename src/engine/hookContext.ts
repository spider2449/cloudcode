// Pure formatting for hook stdout fed back into the model as context.
// Hook output is untrusted local-command data; the labels keep its provenance
// visible next to the tool result it annotates.
export function hookContextBlock(event: "PreToolUse" | "PostToolUse", context: string): string {
  return context ? `[${event} hook output]\n${context}` : "";
}

export function withHookContext(content: string, pre: string, post: string): string {
  const head = pre ? `${hookContextBlock("PreToolUse", pre)}\n\n` : "";
  const tail = post ? `\n\n${hookContextBlock("PostToolUse", post)}` : "";
  return `${head}${content}${tail}`;
}
