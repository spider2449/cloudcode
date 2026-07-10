import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";

export function MessageList({ items }: { items: DisplayItem[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        switch (item.kind) {
          case "user":
            return <Text key={i} color="blue">{"> "}{item.text}</Text>;
          case "assistant":
            return <Text key={i}>{renderMarkdown(item.text)}</Text>;
          case "tool":
            return <Text key={i} color="cyan">{"⏺ "}{item.label}</Text>;
          case "notice":
            return <Text key={i} color="gray">{item.text}</Text>;
          case "error":
            return <Text key={i} color="red">{item.text}</Text>;
          case "diff":
            return (
              <Box key={i} flexDirection="column" marginLeft={2}>
                {item.lines.map((l, j) => (
                  <Text key={j} color={l.sign === "+" ? "green" : l.sign === "-" ? "red" : "gray"}>
                    {l.sign} {l.text}
                  </Text>
                ))}
              </Box>
            );
          case "result":
            return (
              <Text key={i} color="gray" dimColor>
                {`✓ done${item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ""}${item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}`}
              </Text>
            );
        }
      })}
    </Box>
  );
}
