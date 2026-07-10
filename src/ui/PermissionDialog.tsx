import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { toolLabel } from "./transcript.js";
import { useTheme } from "./ThemeContext.js";

interface Props {
  request: { toolName: string; input: Record<string, unknown> };
  onDecision(allow: boolean, rememberAs?: "allow" | "deny"): void;
}

interface Option {
  label: string;
  hotkey: string;
  allow: boolean;
  rememberAs?: "allow" | "deny";
}

const BASE_OPTIONS: Option[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "No (n)", hotkey: "n", allow: false }
];

const FILE_OPTIONS: Option[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

export function PermissionDialog({ request, onDecision }: Props) {
  const theme = useTheme();
  const hasFilePath = typeof request.input.file_path === "string";
  const options = hasFilePath ? FILE_OPTIONS : BASE_OPTIONS;
  const [selected, setSelected] = useState(0);

  const decide = (opt: Option) => {
    if (opt.rememberAs) onDecision(opt.allow, opt.rememberAs);
    else onDecision(opt.allow);
  };

  useInput((input, key) => {
    const hot = options.find(o => o.hotkey === input.toLowerCase());
    if (hot) { decide(hot); return; }
    if (key.escape) { onDecision(false); return; }
    if (key.leftArrow || key.upArrow) {
      setSelected(s => (s + options.length - 1) % options.length);
    } else if (key.rightArrow || key.downArrow) {
      setSelected(s => (s + 1) % options.length);
    } else if (key.return) {
      decide(options[selected]);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text color={theme.warning}>Permission required</Text>
      <Text>{toolLabel(request.toolName, request.input)}</Text>
      <Box gap={2} flexWrap="wrap">
        {options.map((opt, i) => (
          <Text key={opt.hotkey} inverse={i === selected}> {opt.label} </Text>
        ))}
      </Box>
    </Box>
  );
}
