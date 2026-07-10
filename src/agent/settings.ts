import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import type { PermissionMode } from "./session.js";

export interface Settings {
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

const VALID_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
const DEFAULT_FILE = () => join(configDir(), "settings.json");

export function loadSettings(filePath: string = DEFAULT_FILE()): Settings {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const out: Settings = {};
    if (typeof raw.provider === "string") out.provider = raw.provider;
    if (typeof raw.model === "string") out.model = raw.model;
    if (VALID_MODES.includes(raw.permissionMode)) out.permissionMode = raw.permissionMode;
    return out;
  } catch {
    // missing or invalid file: no persisted settings
    return {};
  }
}

export function saveSetting(key: keyof Settings, value: string, filePath: string = DEFAULT_FILE()): void {
  const next = { ...loadSettings(filePath), [key]: value };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2));
}
