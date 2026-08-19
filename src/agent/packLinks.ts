import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import { validatePackDirectory, type ValidatedPack } from "./packManifest.js";

export interface PackLink {
  name: string;
  version: string;
  path: string;
  digest: string;
  linkedAt: string;
}

export interface ProjectPackEnablement {
  schemaVersion: 1;
  enabled: Array<{ name: string; version: string; digest: string }>;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function packLinksPath(base: string = configDir()): string { return join(base, "packs", "links.json"); }
export function projectPacksPath(cwd: string): string { return join(cwd, ".cloudcode", "packs.json"); }

function isLink(value: unknown): value is PackLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<PackLink>;
  return typeof link.name === "string" && typeof link.version === "string" && typeof link.path === "string" &&
    typeof link.digest === "string" && typeof link.linkedAt === "string";
}

export function loadPackLinks(base: string = configDir()): PackLink[] {
  try {
    const value = JSON.parse(readFileSync(packLinksPath(base), "utf8"));
    return Array.isArray(value?.links) ? value.links.filter(isLink) : [];
  } catch { return []; }
}

export function savePackLinks(links: PackLink[], base: string = configDir()): void {
  atomicJson(packLinksPath(base), { schemaVersion: 1, links });
}

export function linkPack(path: string, base: string = configDir(), now: Date = new Date()): PackLink {
  if (/^[a-z]+:\/\//i.test(path)) throw new Error("Pack links accept local filesystem paths only, not URLs.");
  const validation = validatePackDirectory(path);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  const pack = validation.pack;
  const links = loadPackLinks(base);
  const collision = links.find(link => link.name === pack.manifest.name && link.path !== pack.path);
  if (collision) throw new Error(`Pack name ${pack.manifest.name} is already linked from ${collision.path}.`);
  const next: PackLink = {
    name: pack.manifest.name, version: pack.manifest.version, path: pack.path,
    digest: pack.digest, linkedAt: now.toISOString()
  };
  savePackLinks([...links.filter(link => link.name !== next.name), next], base);
  return next;
}

export function unlinkPack(name: string, yes: boolean, base: string = configDir()): void {
  if (!yes) throw new Error("Pack unlink requires --yes.");
  const links = loadPackLinks(base);
  if (!links.some(link => link.name === name)) throw new Error(`Pack is not linked: ${name}.`);
  savePackLinks(links.filter(link => link.name !== name), base);
}

export function loadProjectPackEnablement(cwd: string): ProjectPackEnablement {
  try {
    const value = JSON.parse(readFileSync(projectPacksPath(cwd), "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.enabled)) throw new Error("invalid");
    const enabled = value.enabled.filter((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Record<string, unknown>;
      return typeof entry.name === "string" && typeof entry.version === "string" && typeof entry.digest === "string";
    });
    return { schemaVersion: 1, enabled };
  } catch { return { schemaVersion: 1, enabled: [] }; }
}

export function saveProjectPackEnablement(cwd: string, value: ProjectPackEnablement): void {
  atomicJson(projectPacksPath(cwd), value);
}

export function currentLinkedPack(name: string, base: string = configDir()): {
  link: PackLink; pack: ValidatedPack; stale: boolean;
} {
  const link = loadPackLinks(base).find(item => item.name === name);
  if (!link) throw new Error(`Pack is not linked: ${name}.`);
  const validation = validatePackDirectory(link.path);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  return { link, pack: validation.pack, stale: validation.pack.digest !== link.digest || validation.pack.manifest.version !== link.version };
}
