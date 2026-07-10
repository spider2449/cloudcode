import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionEntry } from "../agent/sessionIndex.js";

interface Props {
  entries: SessionEntry[];
  onPick(entry: SessionEntry): void;
  onCancel(): void;
}

export function ResumePicker({ entries, onPick, onCancel }: Props) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(entries.length - 1, i + 1));
    else if (key.return && entries[index]) onPick(entries[index]);
  });

  if (entries.length === 0) {
    return <Text color="gray">No past sessions. Press Esc to close.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="yellow">Resume a session (↑/↓, Enter, Esc)</Text>
      {entries.map((e, i) => (
        <Text key={e.id} inverse={i === index}>
          {e.timestamp}  [{e.provider}]  {e.firstMessage.slice(0, 60)}
        </Text>
      ))}
    </Box>
  );
}
