import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type PackCapability = "readProject" | "writeProject" | "runProcess" | "localMcp" | "network";
export type PackPlatform = "win32" | "linux" | "darwin";

export interface PackResources {
  skills?: string;
  mcp?: string;
  lsp?: string;
  validations?: string;
  instructions?: string;
  maintenance?: string;
}

export interface PackManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  platforms: PackPlatform[];
  requiredExecutables: string[];
  capabilities: PackCapability[];
  resources: PackResources;
  unknown: Record<string, unknown>;
}

export interface ValidatedPack {
  path: string;
  manifest: PackManifest;
  digest: string;
}

export type PackValidation = { ok: true; pack: ValidatedPack } | { ok: false; errors: string[] };

const CAPABILITIES: readonly PackCapability[] = ["readProject", "writeProject", "runProcess", "localMcp", "network"];
const PLATFORMS: readonly PackPlatform[] = ["win32", "linux", "darwin"];
const RESOURCE_KEYS = ["skills", "mcp", "lsp", "validations", "instructions", "maintenance"] as const;
const KNOWN_KEYS = new Set([
  "schemaVersion", "name", "version", "description", "platforms", "requiredExecutables", "capabilities", "resources"
]);

function canonical(path: string): string {
  try { return realpathSync.native(resolve(path)); } catch { return resolve(path); }
}

function safeRelative(value: unknown, label: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    errors.push(`${label} must be a relative path that stays inside the pack.`);
    return undefined;
  }
  return value;
}

function stringArray(value: unknown, label: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item === "")) {
    errors.push(`${label} must be an array of non-empty strings.`);
    return [];
  }
  return [...new Set(value as string[])];
}

export function parsePackManifest(value: unknown): { manifest?: PackManifest; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { errors: ["Manifest must be a JSON object."] };
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof raw.name !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(raw.name)) {
    errors.push("name must match ^[a-z][a-z0-9-]{1,63}$.");
  }
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)) {
    errors.push("version must be a semantic version such as 1.0.0.");
  }
  if (typeof raw.description !== "string" || raw.description.trim() === "") errors.push("description must be non-empty.");
  const platforms = stringArray(raw.platforms, "platforms", errors);
  if (platforms.some(item => !(PLATFORMS as readonly string[]).includes(item))) errors.push(`platforms may contain only ${PLATFORMS.join(", ")}.`);
  const capabilities = stringArray(raw.capabilities, "capabilities", errors);
  if (capabilities.some(item => !(CAPABILITIES as readonly string[]).includes(item))) {
    errors.push(`capabilities may contain only ${CAPABILITIES.join(", ")}.`);
  }
  const requiredExecutables = stringArray(raw.requiredExecutables, "requiredExecutables", errors);
  const resourcesRaw = raw.resources;
  if (resourcesRaw !== undefined && (!resourcesRaw || typeof resourcesRaw !== "object" || Array.isArray(resourcesRaw))) {
    errors.push("resources must be an object.");
  }
  const resourceObject = resourcesRaw && typeof resourcesRaw === "object" && !Array.isArray(resourcesRaw)
    ? resourcesRaw as Record<string, unknown> : {};
  const resources: PackResources = {};
  for (const key of RESOURCE_KEYS) {
    const path = safeRelative(resourceObject[key], `resources.${key}`, errors);
    if (path) resources[key] = path;
  }
  if (errors.length) return { errors };
  return {
    manifest: {
      schemaVersion: 1, name: raw.name as string, version: raw.version as string,
      description: raw.description as string, platforms: platforms as PackPlatform[],
      requiredExecutables, capabilities: capabilities as PackCapability[], resources,
      unknown: Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS.has(key)))
    },
    errors
  };
}

function collectFiles(path: string, root: string, errors: string[]): string[] {
  if (!existsSync(path)) { errors.push(`Declared resource does not exist: ${relative(root, path)}`); return []; }
  const info = lstatSync(path);
  if (info.isSymbolicLink()) { errors.push(`Pack resources may not be symbolic links: ${relative(root, path)}`); return []; }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) { errors.push(`Unsupported resource type: ${relative(root, path)}`); return []; }
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => collectFiles(join(path, entry.name), root, errors));
}

export function validatePackDirectory(path: string): PackValidation {
  const root = canonical(path);
  let rawText: string;
  let raw: unknown;
  try { rawText = readFileSync(join(root, "cloudcode-pack.json"), "utf8"); raw = JSON.parse(rawText); }
  catch (err) { return { ok: false, errors: [`cloudcode-pack.json: ${err instanceof Error ? err.message : String(err)}`] }; }
  const parsed = parsePackManifest(raw);
  if (!parsed.manifest) return { ok: false, errors: parsed.errors };
  const errors: string[] = [];
  const files: string[] = [];
  for (const resource of Object.values(parsed.manifest.resources)) {
    const target = canonical(join(root, resource));
    if (target !== root && !target.startsWith(root + sep)) { errors.push(`Resource escaped pack root: ${resource}`); continue; }
    files.push(...collectFiles(target, root, errors));
  }
  for (const key of ["mcp", "lsp", "validations", "maintenance"] as const) {
    const resource = parsed.manifest.resources[key];
    if (!resource) continue;
    try { JSON.parse(readFileSync(join(root, resource), "utf8")); }
    catch { errors.push(`${resource} must contain valid JSON.`); }
  }
  if (errors.length) return { ok: false, errors };
  const hash = createHash("sha256").update("cloudcode-pack.json\0").update(rawText).update("\0");
  for (const file of [...new Set(files)].sort()) {
    hash.update(relative(root, file).replaceAll("\\", "/")).update("\0").update(readFileSync(file)).update("\0");
  }
  return { ok: true, pack: { path: root, manifest: parsed.manifest, digest: hash.digest("hex") } };
}
