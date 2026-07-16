import { loadSettings, saveSetting } from "../agent/settings.js";

export interface Theme {
  user: string;
  accent: string;
  muted: string;
  error: string;
  success: string;
  removed: string;
  warning: string;
  // Color for the streaming "thinking" preview, kept visually distinct from
  // real assistant/user text so the two are never confused (dim alone isn't
  // reliably rendered by every terminal).
  thinking: string;
}

export const THEMES: Record<string, Theme> = {
  dark: { user: "blue", accent: "cyan", muted: "gray", error: "red", success: "green", removed: "red", warning: "yellow", thinking: "magenta" },
  light: { user: "magenta", accent: "blue", muted: "blackBright", error: "red", success: "green", removed: "red", warning: "magenta", thinking: "cyan" },
  mono: { user: "white", accent: "white", muted: "gray", error: "white", success: "white", removed: "gray", warning: "white", thinking: "gray" }
};

export function loadThemeName(filePath?: string): string {
  const { theme } = loadSettings(filePath);
  return theme && theme in THEMES ? theme : "dark";
}

export function saveThemeName(name: string, filePath?: string): void {
  saveSetting("theme", name, filePath);
}
