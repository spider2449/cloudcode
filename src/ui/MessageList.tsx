import React from "react";
import { Box, Static, Text } from "ink";
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { useTheme } from "./ThemeContext.js";
import type { Theme } from "./theme.js";

function renderItem(item: DisplayItem, i: number, theme: Theme): React.ReactNode {
  switch (item.kind) {
    case "user":
      return <Text key={i} color={theme.user}>{"> "}{item.text}</Text>;
    case "assistant":
      return <Text key={i}>{renderMarkdown(item.text)}</Text>;
    case "tool":
      return <Text key={i} color={theme.accent}>{"⏺ "}{item.label}</Text>;
    case "notice":
      return <Text key={i} color={theme.muted}>{item.text}</Text>;
    case "error":
      return <Text key={i} color={theme.error}>{item.text}</Text>;
    case "diff":
      return (
        <Box key={i} flexDirection="column" marginLeft={2}>
          {item.lines.map((l, j) => (
            <Text key={j} color={l.sign === "+" ? theme.success : l.sign === "-" ? theme.removed : theme.muted}>
              {l.sign} {l.text}
            </Text>
          ))}
        </Box>
      );
    case "result":
      return (
        <Text key={i} color={theme.muted} dimColor>
          {`✓ done${item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ""}${item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}`}
        </Text>
      );
  }
}

// Completed transcript items render through <Static> so Ink writes them once
// into terminal scrollback instead of repainting the whole history every
// frame. Without this, a history taller than the terminal makes Ink emit
// clearTerminal (which erases scrollback) on every render, breaking mouse
// scrolling. Static is append-only: to reset the transcript (e.g. /clear),
// bump `staticKey` to remount it alongside emptying `items`.
export function MessageList({ items, staticKey = 0 }: { items: DisplayItem[]; staticKey?: number }) {
  const theme = useTheme();
  return (
    <Static key={staticKey} items={items}>
      {(item, i) => renderItem(item, i, theme)}
    </Static>
  );
}
