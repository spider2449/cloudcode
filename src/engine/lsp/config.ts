import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../agent/providers.js";
import { DEFAULT_SERVERS, type ServerConfig } from "./defaults.js";

export { DEFAULT_SERVERS, type ServerConfig };

export interface RegistryOverridesByScope {
  user: Record<string, Partial<ServerConfig>>;
  project: Record<string, Partial<ServerConfig>>;
}

function readJson(path: string): Record<string, Partial<ServerConfig>> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadRegistryOverrides(
  userPath: string = join(configDir(), "lsp.json"),
  projectPath: string = join(process.cwd(), ".cloudcode", "lsp.json")
): RegistryOverridesByScope {
  return { user: readJson(userPath), project: readJson(projectPath) };
}

export function mergeRegistry(
  overrides: RegistryOverridesByScope,
  includeProject = true
): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = {};
  for (const [lang, cfg] of Object.entries(DEFAULT_SERVERS)) merged[lang] = { ...cfg };

  const scopes = includeProject ? [overrides.user, overrides.project] : [overrides.user];
  for (const scope of scopes) {
    for (const [lang, cfg] of Object.entries(scope)) {
      merged[lang] = { ...(merged[lang] ?? { extensions: [], command: "", args: [], rootMarkers: [] }), ...cfg };
    }
  }

  for (const [lang, cfg] of Object.entries(merged)) {
    if (cfg.enabled === false) delete merged[lang];
  }
  return merged;
}

export function loadRegistry(
  userPath: string = join(configDir(), "lsp.json"),
  projectPath: string = join(process.cwd(), ".cloudcode", "lsp.json"),
  includeProject = true
): Record<string, ServerConfig> {
  return mergeRegistry(loadRegistryOverrides(userPath, projectPath), includeProject);
}
