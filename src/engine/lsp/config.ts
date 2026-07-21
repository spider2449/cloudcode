import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { DEFAULT_SERVERS, type ServerConfig } from "./defaults.js";

export { DEFAULT_SERVERS, type ServerConfig };

function readJson(path: string): Record<string, Partial<ServerConfig>> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadRegistry(
  userPath: string = join(configDir(), "lsp.json"),
  projectPath: string = join(process.cwd(), ".cloudcode", "lsp.json")
): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = {};
  for (const [lang, cfg] of Object.entries(DEFAULT_SERVERS)) merged[lang] = { ...cfg };

  for (const overrides of [readJson(userPath), readJson(projectPath)]) {
    for (const [lang, cfg] of Object.entries(overrides)) {
      merged[lang] = { ...(merged[lang] ?? { extensions: [], command: "", args: [], rootMarkers: [] }), ...cfg };
    }
  }

  for (const [lang, cfg] of Object.entries(merged)) {
    if (cfg.enabled === false) delete merged[lang];
  }
  return merged;
}
