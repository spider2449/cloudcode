import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { useTheme } from "./ThemeContext.js";

export function MessageList({ items }: { items: DisplayItem[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
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
      })}
    </Box>
  );
}
