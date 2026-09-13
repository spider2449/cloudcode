// Browser-safe GUI slash-command names. desktop/renderer runs in a Vite
// browser bundle where node:* imports are externalized, so it must not
// import buildRegistry from ./builtins.js (which pulls fs/os/path and the
// whole agent surface). This static list is the single browser-safe copy;
// tests/desktop-chatParity.test.ts pins it against buildRegistry keys so
// the two can never drift.
export const GUI_SLASH_NAMES: readonly string[] = [
  "help",
  "clear",
  "compact",
  "config",
  "context",
  "init",
  "model",
  "new",
  "permissions",
  "provider",
  "resume",
  "set",
  "cost",
  "changes",
  "diff",
  "undo",
  "review",
  "effort",
  "memory",
  "statusline",
  "mcp",
  "skills",
  "skill",
];
