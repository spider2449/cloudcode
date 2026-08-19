import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunLimits } from "../engine/runLimits.js";
import { configDir } from "./providers.js";
import { resolvePackContributions } from "./packs.js";

export type MaintenanceExecution = "analysis" | "isolatedVerification";
export type MaintenanceSource = "builtin" | "user" | "project" | `pack:${string}`;

export interface MaintenanceProfile {
  name: string;
  prompt: string;
  execution: MaintenanceExecution;
  validationProfile?: string;
  limits: RunLimits;
  networkMode: "offlineStrict" | "providerOnly";
  source: MaintenanceSource;
}

export interface MaintenanceConfigResult { profiles: MaintenanceProfile[]; warnings: string[]; }

const DEFAULT_LIMITS: RunLimits = { maxTurns: 6, timeoutMs: 10 * 60_000 };

export const BUILTIN_MAINTENANCE_PROFILES: MaintenanceProfile[] = [
  { name: "health", prompt: "Summarize repository health from local evidence. Report failing or missing checks without modifying files.", execution: "analysis", limits: DEFAULT_LIMITS, networkMode: "providerOnly", source: "builtin" },
  { name: "test-failures", prompt: "Diagnose current locally recorded test failures and likely causes. Do not run commands or modify files.", execution: "analysis", limits: DEFAULT_LIMITS, networkMode: "providerOnly", source: "builtin" },
  { name: "docs-drift", prompt: "Compare documentation with code and report concrete drift with file references. Do not modify files.", execution: "analysis", limits: DEFAULT_LIMITS, networkMode: "providerOnly", source: "builtin" },
  { name: "technical-debt", prompt: "Inventory TODOs and technical debt from local project evidence. Rank findings and do not modify files.", execution: "analysis", limits: DEFAULT_LIMITS, networkMode: "offlineStrict", source: "builtin" },
  { name: "dependencies", prompt: "Inventory dependencies using checked-in manifests and lockfiles only. Do not claim this is a current vulnerability audit.", execution: "analysis", limits: DEFAULT_LIMITS, networkMode: "offlineStrict", source: "builtin" }
];

function positive(value: unknown, integer = false): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

function parseProfiles(value: unknown, source: MaintenanceSource, label: string): MaintenanceConfigResult {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as { profiles?: unknown }).profiles : undefined;
  if (raw === undefined) return { profiles: [], warnings: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { profiles: [], warnings: [`${label}: profiles must be an object.`] };
  const profiles: MaintenanceProfile[] = [];
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { warnings.push(`${label}:${name} must be an object.`); continue; }
    const item = entry as Record<string, unknown>;
    const execution = item.execution;
    const networkMode = item.networkMode;
    const limits = item.limits && typeof item.limits === "object" ? item.limits as Record<string, unknown> : {};
    if (typeof item.prompt !== "string" || item.prompt.trim() === "" ||
      (execution !== "analysis" && execution !== "isolatedVerification") ||
      (networkMode !== "offlineStrict" && networkMode !== "providerOnly") ||
      (item.validationProfile !== undefined && typeof item.validationProfile !== "string")) {
      warnings.push(`${label}:${name} has an invalid prompt, execution, networkMode, or validationProfile.`); continue;
    }
    const maxTurns = limits.maxTurns === undefined ? undefined : positive(limits.maxTurns, true);
    const timeoutMs = limits.timeoutMs === undefined ? undefined : positive(limits.timeoutMs, true);
    const maxCostUsd = limits.maxCostUsd === undefined ? undefined : positive(limits.maxCostUsd);
    if ((limits.maxTurns !== undefined && maxTurns === undefined) || (limits.timeoutMs !== undefined && timeoutMs === undefined) ||
      (limits.maxCostUsd !== undefined && maxCostUsd === undefined)) {
      warnings.push(`${label}:${name} has invalid positive run limits.`); continue;
    }
    profiles.push({
      name, prompt: item.prompt, execution, networkMode, source,
      limits: { ...(maxTurns ? { maxTurns } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(maxCostUsd ? { maxCostUsd } : {}) },
      ...(typeof item.validationProfile === "string" ? { validationProfile: item.validationProfile } : {})
    });
  }
  return { profiles, warnings };
}

function readConfig(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export function loadMaintenanceProfiles(cwd: string, base: string = configDir()): MaintenanceConfigResult {
  const warnings: string[] = [];
  const byName = new Map(BUILTIN_MAINTENANCE_PROFILES.map(profile => [profile.name, profile]));
  const contributions = resolvePackContributions(cwd, base);
  warnings.push(...contributions.warnings);
  for (const { pack } of contributions.packs) {
    const resource = pack.manifest.resources.maintenance;
    if (!resource) continue;
    const parsed = parseProfiles(readConfig(join(pack.path, resource)), `pack:${pack.manifest.name}`, resource);
    warnings.push(...parsed.warnings);
    for (const profile of parsed.profiles) byName.set(profile.name, profile);
  }
  for (const [path, source] of [
    [join(base, "maintenance.json"), "user"], [join(cwd, ".cloudcode", "maintenance.json"), "project"]
  ] as const) {
    const parsed = parseProfiles(readConfig(path), source, path);
    warnings.push(...parsed.warnings);
    for (const profile of parsed.profiles) byName.set(profile.name, profile);
  }
  return { profiles: [...byName.values()], warnings };
}

export function maintenanceConfigurationDigests(cwd: string, base: string = configDir()): {
  configDigest: string; packDigest: string;
} {
  const config = createHash("sha256");
  for (const path of [join(base, "maintenance.json"), join(cwd, ".cloudcode", "maintenance.json")]) {
    try { config.update(path.endsWith("maintenance.json") ? path.slice(-32) : path).update("\0").update(readFileSync(path)).update("\0"); }
    catch { /* missing config has no contribution */ }
  }
  const packs = resolvePackContributions(cwd, base).packs
    .map(({ pack }) => `${pack.manifest.name}\0${pack.manifest.version}\0${pack.digest}`).sort();
  return { configDigest: config.digest("hex"), packDigest: createHash("sha256").update(packs.join("\0")).digest("hex") };
}
