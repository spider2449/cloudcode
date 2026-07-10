import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import type { PermissionMode } from "./session.js";

export interface Settings {
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

// bypassPermissions is deliberately not persistable: a saved bypass would make
// every future session auto-approve all tool calls. It stays session-only.
const PERSISTABLE_MODES: PermissionMode[] = ["default", "acceptEdits"];
const DEFAULT_FILE = () => join(configDir(), "settings.json");

// Raw file contents without validation; saves merge into this so keys the
// validator rejects (or does not know) are never silently erased.
function loadRaw(filePath: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function loadSettings(filePath: string = DEFAULT_FILE()): Settings {
  const raw = loadRaw(filePath);
  const out: Settings = {};
  if (typeof raw.provider === "string") out.provider = raw.provider;
  if (typeof raw.model === "string") out.model = raw.model;
  if (PERSISTABLE_MODES.includes(raw.permissionMode as PermissionMode)) {
    out.permissionMode = raw.permissionMode as PermissionMode;
  }
  return out;
}

export function saveSetting(key: keyof Settings, value: string, filePath: string = DEFAULT_FILE()): void {
  const next = { ...loadRaw(filePath), [key]: value };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2));
}
