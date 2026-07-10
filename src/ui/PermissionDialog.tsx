import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { toolLabel } from "./transcript.js";

interface Props {
  request: { toolName: string; input: Record<string, unknown> };
  onDecision(allow: boolean): void;
}

export function PermissionDialog({ request, onDecision }: Props) {
  const [selected, setSelected] = useState<0 | 1>(0); // 0 = Yes, 1 = No

  useInput((input, key) => {
    if (input.toLowerCase() === "y") onDecision(true);
    else if (input.toLowerCase() === "n" || key.escape) onDecision(false);
    else if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected(s => (s === 0 ? 1 : 0));
    } else if (key.return) onDecision(selected === 0);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Permission required</Text>
      <Text>{toolLabel(request.toolName, request.input)}</Text>
      <Box gap={2}>
        <Text inverse={selected === 0}> Yes (y) </Text>
        <Text inverse={selected === 1}> No (n) </Text>
      </Box>
    </Box>
  );
}
