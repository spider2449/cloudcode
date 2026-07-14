import { loadSettings, saveSetting } from "../agent/settings.js";

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

export function loadThemeName(filePath?: string): string {
  const { theme } = loadSettings(filePath);
  return theme && theme in THEMES ? theme : "dark";
}

export function saveThemeName(name: string, filePath?: string): void {
  saveSetting("theme", name, filePath);
}
