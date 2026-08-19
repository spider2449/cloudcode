import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists as defaultCommandExists } from "../engine/lsp/detect.js";
import type { ServerConfig } from "../engine/lsp/config.js";
import type { McpServerConfig } from "./mcp.js";
import type { VerificationProfile } from "./taskVerification.js";
import type { NetworkMode } from "./networkPolicy.js";
import {
  currentLinkedPack, loadPackLinks, loadProjectPackEnablement, saveProjectPackEnablement,
  type PackLink
} from "./packLinks.js";
import type { ValidatedPack } from "./packManifest.js";

export interface ResolvedPack {
  link: PackLink;
  pack: ValidatedPack;
}

export interface PackContributions {
  packs: ResolvedPack[];
  skillRoots: Array<{ pack: string; path: string }>;
  mcp: Record<string, McpServerConfig>;
  lsp: Record<string, Partial<ServerConfig>>;
  validations: VerificationProfile[];
  instructions: Array<{ pack: string; text: string }>;
  warnings: string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function enabledPacks(cwd: string, base?: string): { packs: ResolvedPack[]; warnings: string[] } {
  const enabled = loadProjectPackEnablement(cwd).enabled;
  const packs: ResolvedPack[] = [];
  const warnings: string[] = [];
  for (const entry of enabled) {
    try {
      const current = currentLinkedPack(entry.name, base);
      if (current.stale || current.link.digest !== entry.digest || current.link.version !== entry.version) {
        warnings.push(`Pack ${entry.name} is stale; relink and re-enable it.`);
        continue;
      }
      packs.push({ link: current.link, pack: current.pack });
    } catch (err) {
      warnings.push(`Pack ${entry.name} is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { packs, warnings };
}

function addUnique<T>(target: Record<string, T>, key: string, value: T): void {
  if (Object.hasOwn(target, key)) throw new Error(`Pack contribution collision: ${key}.`);
  target[key] = value;
}

function validationProfiles(raw: unknown, packName: string): VerificationProfile[] {
  const profilesRaw = raw && typeof raw === "object" ? (raw as { profiles?: unknown }).profiles : undefined;
  if (!profilesRaw || typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) throw new Error(`${packName}: validations.profiles must be an object.`);
  return Object.entries(profilesRaw).map(([name, value]) => {
    const commands = value && typeof value === "object" ? (value as { commands?: unknown }).commands : undefined;
    if (!Array.isArray(commands)) throw new Error(`${packName}:${name} commands must be an array.`);
    return {
      name: `${packName}:${name}`,
      commands: commands.map(entry => {
        if (!entry || typeof entry !== "object" || typeof (entry as { command?: unknown }).command !== "string") {
          throw new Error(`${packName}:${name} has an invalid command.`);
        }
        const item = entry as { command: string; args?: unknown; timeoutMs?: unknown };
        if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some(arg => typeof arg !== "string"))) {
          throw new Error(`${packName}:${name} has invalid args.`);
        }
        return {
          command: item.command, args: (item.args as string[] | undefined) ?? [],
          timeoutMs: typeof item.timeoutMs === "number" ? item.timeoutMs : 10 * 60_000
        };
      })
    };
  });
}

export function resolvePackContributions(cwd: string, base?: string): PackContributions {
  const resolved = enabledPacks(cwd, base);
  const result: PackContributions = {
    packs: resolved.packs, skillRoots: [], mcp: {}, lsp: {}, validations: [], instructions: [], warnings: resolved.warnings
  };
  for (const { pack } of resolved.packs) {
    const { manifest } = pack;
    const prefix = manifest.name;
    if (manifest.resources.skills) result.skillRoots.push({ pack: prefix, path: join(pack.path, manifest.resources.skills) });
    if (manifest.resources.instructions) {
      result.instructions.push({ pack: prefix, text: readFileSync(join(pack.path, manifest.resources.instructions), "utf8").trim() });
    }
    if (manifest.resources.mcp) {
      if (!manifest.capabilities.includes("localMcp")) throw new Error(`${prefix} contributes MCP without localMcp capability.`);
      const raw = readJson(join(pack.path, manifest.resources.mcp)) as { mcpServers?: unknown };
      if (!raw.mcpServers || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers)) throw new Error(`${prefix}: mcpServers must be an object.`);
      for (const [name, config] of Object.entries(raw.mcpServers)) {
        if (!config || typeof config !== "object" || typeof (config as { command?: unknown }).command !== "string") {
          throw new Error(`${prefix}:${name} must be a local stdio MCP command.`);
        }
        if ("url" in config) throw new Error(`${prefix}:${name} may not declare a network MCP transport.`);
        addUnique(result.mcp, `pack__${prefix}__${name}`, config as McpServerConfig);
      }
    }
    if (manifest.resources.lsp) {
      if (!manifest.capabilities.includes("runProcess")) throw new Error(`${prefix} contributes LSP without runProcess capability.`);
      const raw = readJson(join(pack.path, manifest.resources.lsp));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${prefix}: lsp.json must be an object.`);
      for (const [name, config] of Object.entries(raw)) {
        if (!config || typeof config !== "object") throw new Error(`${prefix}:${name} has invalid LSP config.`);
        const item = config as Partial<ServerConfig>;
        if (typeof item.command !== "string" || !Array.isArray(item.args) || item.args.some(arg => typeof arg !== "string") ||
          !Array.isArray(item.extensions) || item.extensions.some(ext => typeof ext !== "string") ||
          !Array.isArray(item.rootMarkers) || item.rootMarkers.some(marker => typeof marker !== "string")) {
          throw new Error(`${prefix}:${name} must declare command, args, extensions, and rootMarkers.`);
        }
        addUnique(result.lsp, `pack__${prefix}__${name}`, item);
      }
    }
    if (manifest.resources.validations) {
      if (!manifest.capabilities.includes("runProcess")) throw new Error(`${prefix} contributes validations without runProcess capability.`);
      result.validations.push(...validationProfiles(readJson(join(pack.path, manifest.resources.validations)), prefix));
    }
  }
  return result;
}

export function enablePack(name: string, cwd: string, mode: NetworkMode, base?: string): void {
  const current = currentLinkedPack(name, base);
  if (current.stale) throw new Error(`Pack ${name} changed since it was linked; inspect and link it again first.`);
  if (current.pack.manifest.capabilities.includes("network") && mode !== "unrestricted") {
    throw new Error(`Pack ${name} declares network capability and cannot be enabled in ${mode}.`);
  }
  if (current.pack.manifest.platforms.length && !current.pack.manifest.platforms.includes(process.platform as never)) {
    throw new Error(`Pack ${name} does not support platform ${process.platform}.`);
  }
  // Parse all contributions now so invalid commands/collisions fail before the
  // project enablement file changes. Temporarily merge with current entries.
  const value = loadProjectPackEnablement(cwd);
  const entry = { name, version: current.link.version, digest: current.link.digest };
  saveProjectPackEnablement(cwd, { schemaVersion: 1, enabled: [...value.enabled.filter(item => item.name !== name), entry] });
  try { resolvePackContributions(cwd, base); }
  catch (err) {
    saveProjectPackEnablement(cwd, value);
    throw err;
  }
}

export function disablePack(name: string, cwd: string): void {
  const value = loadProjectPackEnablement(cwd);
  saveProjectPackEnablement(cwd, { schemaVersion: 1, enabled: value.enabled.filter(item => item.name !== name) });
}

export interface PackDoctorItem { name: string; ok: boolean; details: string[]; }

export function packDoctor(base?: string, exists: (command: string) => boolean = defaultCommandExists): PackDoctorItem[] {
  return loadPackLinks(base).map(link => {
    const details: string[] = [];
    let ok = true;
    try {
      const current = currentLinkedPack(link.name, base);
      if (current.stale) { ok = false; details.push("content digest changed"); }
      const manifest = current.pack.manifest;
      if (manifest.platforms.length && !manifest.platforms.includes(process.platform as never)) {
        ok = false; details.push(`unsupported platform: ${process.platform}`);
      }
      for (const command of manifest.requiredExecutables) {
        if (!exists(command)) { ok = false; details.push(`missing executable: ${command}`); }
      }
    } catch (err) { ok = false; details.push(err instanceof Error ? err.message : String(err)); }
    return { name: link.name, ok, details: details.length ? details : ["ready"] };
  });
}
