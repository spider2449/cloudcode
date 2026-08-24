import { realpathSync } from "node:fs";
import { normalizePath, type PermissionDecision } from "./permissionStore.js";

/**
 * Allow/deny rules for network storage (UNC shares and Windows mapped
 * drives), configured globally in settings.json as `networkStorage`.
 * Matching is done on normalized paths: forward slashes, lowercased on
 * win32 (same convention as permissionStore's normalizePath).
 */
export interface NetworkStorageRule {
  target: string;
  decision: PermissionDecision;
}

// Unlike permissionStore's normalizePath, targets must NOT go through
// resolve(): on Windows resolve("Z:") expands relative to that drive's
// current directory, which would silently corrupt a configured target.
// Lowercasing is unconditional because a target names an SMB share or drive
// letter, never a case-sensitive POSIX path.
export function normalizeNetworkTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isValidTarget(target: string): boolean {
  if (typeof target !== "string") return false;
  const n = normalizeNetworkTarget(target);
  if (n.startsWith("//")) {
    return n.split("/").filter(part => part.length > 0).length >= 2;
  }
  return /^[a-z]:$/.test(n);
}

export function isValidNetworkStorageRule(value: unknown): value is NetworkStorageRule {
  const r = value as NetworkStorageRule;
  return (
    !!r &&
    typeof r === "object" &&
    (r.decision === "allow" || r.decision === "deny") &&
    typeof r.target === "string" &&
    isValidTarget(r.target)
  );
}

/** True for an already-normalized UNC (`//srv/...`) or drive-letter (`x:/...`) path. */
export function isNetworkPath(normalizedPath: string): boolean {
  return normalizedPath.startsWith("//") || /^[a-z]:/.test(normalizedPath);
}

/**
 * Deepest stable root worth remembering a rule for: the share root for UNC
 * paths, the bare drive letter for mapped drives. Undefined for local paths.
 */
export function networkStorageRoot(rawPath: string): string | undefined {
  const p = normalizeNetworkPath(rawPath);
  if (!isNetworkPath(p)) return undefined;
  if (p.startsWith("//")) {
    const parts = p.split("/").filter(part => part.length > 0);
    if (parts.length < 2) return undefined;
    return `//${parts[0]}/${parts[1]}`;
  }
  return p.slice(0, 2);
}

/**
 * Normalizes a tool-supplied path for rule matching. Network-shaped paths
 * (backslash UNC, forward-slash UNC, drive letters) must NOT go through
 * path.resolve(): on POSIX it collapses a UNC's leading "//" to "/" and
 * turns "z:/x" into a cwd-relative path; on Windows it expands a bare
 * "z:" against that drive's current directory. Local paths fall through to
 * permissionStore's resolve-based normalizePath so ".." tricks still fail
 * to masquerade as network roots.
 */
function normalizeNetworkPath(rawPath: string): string {
  const lower = rawPath.toLowerCase();
  if (rawPath.startsWith("\\\\")) {
    return "//" + lower.slice(2).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  }
  if (/^[a-z]:/.test(lower)) {
    return lower.charAt(0) + ":" + lower.slice(2).replace(/\\/g, "/").replace(/\/+$/, "");
  }
  if (rawPath.startsWith("//")) {
    return lower.replace(/\/+$/, "");
  }
  return normalizePath(rawPath);
}

// One lookup per drive letter per process: realpathSync on a disconnected
// drive can take seconds, and mappings do not change mid-session.
const driveUncCache = new Map<string, string | null>();

function realResolveUnc(driveRoot: string): string | null {
  try {
    const resolved = normalizePath(realpathSync(driveRoot));
    // A local fixed drive resolves to itself (no "//" prefix): no mapping.
    return resolved.startsWith("//") ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Returns the UNC target a mapped drive letter points at, or null when the
 * drive has no UNC mapping (local disk, disconnected, or non-Windows).
 * Results are cached for the lifetime of the process.
 */
export function resolveMappedDriveUnc(driveLetter: string): string | null {
  const cached = driveUncCache.get(driveLetter);
  if (cached !== undefined) return cached;
  const resolved = realResolveUnc(driveLetter.toUpperCase() + ":\\");
  driveUncCache.set(driveLetter, resolved);
  return resolved;
}

function defaultResolver(driveRoot: string): string | null {
  const m = /^([a-z]):/.exec(driveRoot);
  return m ? resolveMappedDriveUnc(m[1]) : null;
}

/**
 * The target worth remembering for one tool path: the resolved UNC share
 * root when the path sits on a mapped drive or is a UNC path itself, and
 * undefined otherwise. Unmapped drive-letter paths are ordinary local paths
 * on Windows (every absolute path has a drive letter), so they belong in the
 * project permission store, not global network settings.
 */
export function networkRememberTargetForPath(rawPath: string): string | undefined {
  const p = normalizeNetworkPath(rawPath);
  if (!isNetworkPath(p)) return undefined;
  if (p.startsWith("//")) {
    const parts = p.split("/").filter(part => part.length > 0);
    return parts.length >= 2 ? `//${parts[0]}/${parts[1]}` : undefined;
  }
  const unc = resolveMappedDriveUnc(p.charAt(0));
  return unc ? networkStorageRoot(unc) : undefined;
}

/**
 * Consults the rules for one tool path. Both the literal drive form and its
 * resolved UNC form are matched independently; deny wins across both.
 * `resolveUnc` is injectable for tests.
 */
export function matchNetworkStorage(
  rules: readonly NetworkStorageRule[],
  rawPath: string,
  resolveUnc: (driveRoot: string) => string | null = defaultResolver
): PermissionDecision | undefined {
  const p = normalizeNetworkPath(rawPath);
  if (!isNetworkPath(p)) return undefined;
  const candidates = [p];
  if (/^[a-z]:/.test(p)) {
    const unc = resolveUnc(p.slice(0, 2));
    if (unc && !candidates.includes(unc)) candidates.push(unc);
  }
  let allowed = false;
  for (const rule of rules) {
    const t = normalizeNetworkTarget(rule.target);
    const hit = candidates.some(c => c === t || c.startsWith(t + "/"));
    if (!hit) continue;
    if (rule.decision === "deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : undefined;
}
