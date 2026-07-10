import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../agent/providers.js";

export interface Theme {
  user: string;
  accent: string;
  muted: string;
  error: string;
  success: string;
  removed: string;
  warning: string;
}

export const THEMES: Record<string, Theme> = {
  dark: { user: "blue", accent: "cyan", muted: "gray", error: "red", success: "green", removed: "red", warning: "yellow" },
  light: { user: "magenta", accent: "blue", muted: "blackBright", error: "red", success: "green", removed: "red", warning: "magenta" },
  mono: { user: "white", accent: "white", muted: "gray", error: "white", success: "white", removed: "gray", warning: "white" }
};

const DEFAULT_FILE = () => join(configDir(), "theme.json");

export function loadThemeName(filePath: string = DEFAULT_FILE()): string {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (raw && typeof raw.name === "string" && raw.name in THEMES) return raw.name;
  } catch {
    // missing or invalid file: fall through to default
  }
  return "dark";
}

export function saveThemeName(name: string, filePath: string = DEFAULT_FILE()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ name }, null, 2));
}
