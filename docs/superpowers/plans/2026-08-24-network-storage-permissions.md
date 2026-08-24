# Network Storage Permission Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-target allow/deny rules in global `settings.json` for network storage (UNC paths and Windows mapped drives), consulted by the engine permission decider so allow-listed shares stop prompting and denied shares are blocked.

**Architecture:** A new `src/agent/networkStorage.ts` owns rule types, validation, normalization, and matching (including mapped-drive → UNC resolution with a per-session cache). `settings.json` gains a validated `networkStorage` array; `decidePermission` consults the rules before its outside-cwd forced-`ask`; the permission overlay's "always" answer writes back to `settings.json` instead of the project store when the path is a network path outside cwd.

**Tech Stack:** TypeScript 7 (strict), Node `node:fs`/`node:path`, vitest, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-24-network-storage-permissions-design.md`

## Global Constraints

- All code, comments, identifiers in English only.
- `"strict": true` stays; no `any`, no non-null (`!`) assertions.
- No new try/catch boundaries beyond what this plan shows (config loaders catch their own errors; `realpathSync` failure is caught inside `networkStorage.ts` only).
- Config loaders follow the existing pattern: wrap their own parsing, drop invalid entries silently.
- No file past ~600 lines (`npm run lint:size` must pass).
- Tests land in the same commit as the feature they cover.
- Run `npm test` (vitest), `npm run lint`, `npm run lint:size`, `npm run build` before each commit that closes a task.

---

### Task 1: `src/agent/networkStorage.ts` — types, validation, matching

**Files:**
- Create: `src/agent/networkStorage.ts`
- Modify: `src/agent/permissionStore.ts:20` (export `normalizePath`)
- Create: `tests/networkStorage.test.ts`

**Interfaces:**
- Consumes: nothing new; imports `normalizePath` from `permissionStore.js` (made exported in this task).
- Produces (used by Tasks 2–5):
  - `export interface NetworkStorageRule { target: string; decision: "allow" | "deny"; }`
  - `export function isValidNetworkStorageRule(value: unknown): value is NetworkStorageRule`
  - `export function normalizeNetworkTarget(target: string): string`
  - `export function isNetworkPath(normalizedPath: string): boolean`
  - `export function networkStorageRoot(rawPath: string): string | undefined`
  - `export function matchNetworkStorage(rules: readonly NetworkStorageRule[], rawPath: string): PermissionDecision | undefined`

- [ ] **Step 1: Export `normalizePath` from permissionStore**

In `src/agent/permissionStore.ts`, change line 20 from:

```ts
function normalizePath(p: string): string {
```

to:

```ts
// Shared with agent/networkStorage.ts so tool paths and network targets are
// normalized identically (resolve + forward slashes + win32 case folding).
export function normalizePath(p: string): string {
```

No behavior change; all existing callers keep working.

- [ ] **Step 2: Write the failing tests**

Create `tests/networkStorage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isValidNetworkStorageRule,
  normalizeNetworkTarget,
  isNetworkPath,
  networkStorageRoot,
  matchNetworkStorage,
  type NetworkStorageRule
} from "../src/agent/networkStorage.js";

const rules = (...rs: Array<[string, "allow" | "deny"]>): NetworkStorageRule[] =>
  rs.map(([target, decision]) => ({ target, decision }));

describe("normalizeNetworkTarget", () => {
  it("converts backslashes to slashes, strips trailing slashes, lowercases", () => {
    expect(normalizeNetworkTarget("\\\\Server\\Share\\")).toBe("//server/share");
    expect(normalizeNetworkTarget("Z:\\")).toBe("z:");
    expect(normalizeNetworkTarget("z:/Data/Sub/")).toBe("z:/data/sub");
  });
});

describe("isValidNetworkStorageRule", () => {
  it("accepts UNC and drive-letter roots", () => {
    expect(isValidNetworkStorageRule({ target: "\\\\srv\\sh", decision: "allow" })).toBe(true);
    expect(isValidNetworkStorageRule({ target: "Z:", decision: "deny" })).toBe(true);
    expect(isValidNetworkStorageRule({ target: "//srv/sh/sub", decision: "deny" })).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(isValidNetworkStorageRule({ target: "//srv", decision: "allow" })).toBe(false);
    expect(isValidNetworkStorageRule({ target: "//srv/sh", decision: "maybe" })).toBe(false);
    expect(isValidNetworkStorageRule({ target: 42, decision: "allow" })).toBe(false);
    expect(isValidNetworkStorageRule(null)).toBe(false);
    expect(isValidNetworkStorageRule("Z:")).toBe(false);
  });
});

describe("isNetworkPath", () => {
  it("detects normalized UNC paths and drive-letter paths", () => {
    expect(isNetworkPath("//server/share/file.txt")).toBe(true);
    expect(isNetworkPath("z:/data/a.txt")).toBe(true);
    // resolve() output on any platform never looks like these:
    expect(isNetworkPath("/home/user/project/a.txt")).toBe(false);
    expect(isNetworkPath("c:/users/x/appdata/a.txt")).toBe(true);
  });
});

describe("networkStorageRoot", () => {
  it("reduces a UNC path to its share root", () => {
    expect(networkStorageRoot("//server/share/deep/file.txt")).toBe("//server/share");
    expect(networkStorageRoot("//server/share")).toBe("//server/share");
  });

  it("reduces a drive path to the bare drive letter", () => {
    expect(networkStorageRoot("z:/data/a.txt")).toBe("z:");
  });

  it("returns undefined for local paths", () => {
    expect(networkStorageRoot("/home/user/project/a.txt")).toBeUndefined();
  });
});

describe("matchNetworkStorage", () => {
  it("matches equal and deeper paths under a UNC share root", () => {
    const rs = rules(["//server/share", "deny"]);
    expect(matchNetworkStorage(rs, "//server/share")).toBe("deny");
    expect(matchNetworkStorage(rs, "//server/share/sub/f.txt")).toBe("deny");
  });

  it("does not treat sibling shares as matches", () => {
    expect(matchNetworkStorage(rules(["//server/share", "deny"]), "//server/other/f.txt")).toBeUndefined();
  });

  it("matches drive-letter paths by literal form", () => {
    expect(matchNetworkStorage(rules(["z:", "allow"]), "z:/data/f.txt")).toBe("allow");
    expect(matchNetworkStorage(rules(["z:", "allow"]), "y:/data/f.txt")).toBeUndefined();
  });

  it("deny wins over allow across both forms of a mapped drive", () => {
    // z:/f.txt matches both the drive rule and (when Z: maps to //srv/sh)
    // the UNC rule; deny beats allow regardless of rule order.
    const rs = rules(["//srv/sh", "deny"], ["z:", "allow"]);
    expect(matchNetworkStorage(rs, "z:/f.txt", () => "//srv/sh")).toBe("deny");
    expect(matchNetworkStorage([...rs].reverse(), "z:/f.txt", () => "//srv/sh")).toBe("deny");
  });

  it("uses resolved UNC form for mapped drives via the injected resolver", () => {
    const rs = rules(["//srv/sh", "allow"]);
    expect(matchNetworkStorage(rs, "z:/f.txt", () => "//srv/sh")).toBe("allow");
    expect(matchNetworkStorage(rs, "z:/f.txt", () => null)).toBeUndefined();
  });

  it("ignores non-network paths entirely", () => {
    expect(matchNetworkStorage(rules(["z:", "allow"]), "/home/u/p/f.txt")).toBeUndefined();
  });
});
```

Note: `matchNetworkStorage` takes an optional third parameter `resolveUnc?: (driveRoot: string) => string | null` for testability — production passes the real cached resolver; tests pass fakes. This keeps `fs.realpathSync` out of unit tests while still exercising dual-form logic everywhere (CI runs on Linux too, where real mapped drives don't exist).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/networkStorage.test.ts`
Expected: FAIL — cannot resolve `../src/agent/networkStorage.js`.

- [ ] **Step 4: Implement `src/agent/networkStorage.ts`**

```ts
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
  return /^[a-zA-Z]:$/.test(n);
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
  return normalizedPath.startsWith("//") || /^[a-zA-Z]:/.test(normalizedPath);
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
  const m = /^([a-zA-Z]):/.exec(driveRoot);
  return m ? resolveMappedDriveUnc(m[1]) : null;
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
  const m = /^([a-zA-Z]):/.exec(p);
  if (m) {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/networkStorage.test.ts`
Expected: PASS (all cases).

Also run `npx vitest run tests/permissionStore.test.ts` to confirm exporting `normalizePath` broke nothing.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/networkStorage.ts src/agent/permissionStore.ts tests/networkStorage.test.ts
git commit -m "feat(agent): add networkStorage rule matching module"
```

---

### Task 2: Settings integration

**Files:**
- Modify: `src/agent/settings.ts`
- Modify: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `isValidNetworkStorageRule`, `normalizeNetworkTarget`, `NetworkStorageRule` from `src/agent/networkStorage.js` (Task 1).
- Produces (used by Tasks 3–5):
  - `Settings.networkStorage?: NetworkStorageRule[]`
  - `saveSetting` accepts `NetworkStorageRule[]` values.
  - `export function saveNetworkStorageRule(target: string, decision: "allow" | "deny", filePath?: string): void`

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings.test.ts` (inside a new top-level `describe`):

```ts
import { loadSettings, saveSetting, saveNetworkStorageRule } from "../src/agent/settings.js";

describe("networkStorage setting", () => {
  it("round-trips valid rules through save/load", () => {
    const file = join(dir(), "settings.json");
    saveSetting(
      "networkStorage",
      [{ target: "\\\\srv\\sh", decision: "allow" }],
      file
    );
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" }
    ]);
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({
      networkStorage: [
        { target: "//srv/sh", decision: "allow" },
        { target: "//only-server", decision: "allow" },
        { target: "Z:", decision: "maybe" },
        "garbage",
        { target: 42, decision: "deny" }
      ]
    }));
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" }
    ]);
  });

  it("ignores a non-array networkStorage", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ networkStorage: "all" }));
    expect(loadSettings(file).networkStorage).toBeUndefined();
  });

  it("upserts a single rule via saveNetworkStorageRule, replacing same target", () => {
    const file = join(dir(), "settings.json");
    saveNetworkStorageRule("\\\\srv\\sh", "deny", file);
    saveNetworkStorageRule("//srv/sh", "allow", file);
    saveNetworkStorageRule("Z:", "allow", file);
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" },
      { target: "z:", decision: "allow" }
    ]);
  });

  it("preserves unknown sibling keys when saving a rule", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ futureKey: "x" }));
    saveNetworkStorageRule("Z:", "deny", file);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["futureKey"]).toBe("x");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — `saveNetworkStorageRule` not exported; round-trip test fails because loader drops the array.

- [ ] **Step 3: Implement**

In `src/agent/settings.ts`:

Add import:

```ts
import {
  isValidNetworkStorageRule,
  normalizeNetworkTarget,
  type NetworkStorageRule
} from "./networkStorage.js";
```

Extend the `Settings` interface (after `statusLineItems`):

```ts
  /** Global allow/deny rules for network storage (UNC shares, mapped drives). */
  networkStorage?: NetworkStorageRule[];
```

Widen `saveSetting`'s value union:

```ts
export function saveSetting(key: keyof Settings, value: string | boolean | string[] | NetworkStorageRule[], filePath: string = DEFAULT_FILE()): void {
```

In `loadSettings`, after the `statusLineItems` block:

```ts
  if (Array.isArray(raw.networkStorage)) {
    const rules = raw.networkStorage
      .filter(isValidNetworkStorageRule)
      .map(r => ({ target: normalizeNetworkTarget(r.target), decision: r.decision }));
    out.networkStorage = rules;
  }
```

Append the helper at the end of the file:

```ts
/** Upserts one network-storage rule, keyed on the normalized target. */
export function saveNetworkStorageRule(
  target: string,
  decision: NetworkStorageRule["decision"],
  filePath: string = DEFAULT_FILE()
): void {
  const normalized = normalizeNetworkTarget(target);
  const rules = (loadSettings(filePath).networkStorage ?? []).filter(r => r.target !== normalized);
  rules.push({ target: normalized, decision });
  saveSetting("networkStorage", rules, filePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/settings.ts tests/settings.test.ts
git commit -m "feat(agent): persist networkStorage rules in global settings"
```

---

### Task 3: Engine decision integration

**Files:**
- Modify: `src/engine/permissions.ts`
- Modify: `tests/engine-permissions.test.ts`

**Interfaces:**
- Consumes: `matchNetworkStorage`, `networkStorageRoot`, `type NetworkStorageRule` (Task 1); existing private `isInsideCwd`, `ruleScope`.
- Produces (used by Task 4):
  - `decidePermission(toolName, input, mode, store, cwd, networkStorage?: readonly NetworkStorageRule[])` — new optional 6th param.
  - `export function networkRememberTarget(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined`

- [ ] **Step 1: Write the failing tests**

Append to the top-level `describe` in `tests/engine-permissions.test.ts` (reuse whatever helpers that file already defines for building stores/cwds; shown here assuming `store = new PermissionStore(cwd)` with no extra rules and `cwd = mkdtempSync(...)`):

```ts
import { matchNetworkStorage, type NetworkStorageRule } from "../src/agent/networkStorage.js";

const netRules = (...rs: Array<[string, "allow" | "deny"]>): NetworkStorageRule[] =>
  rs.map(([target, decision]) => ({ target, decision }));

describe("network storage rules", () => {
  it("a network deny blocks reads and edits outright", () => {
    const rs = netRules(["//server/share", "deny"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "default", store, cwd, rs)).toBe("deny");
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "bypassPermissions", store, cwd, rs)).toBe("deny");
  });

  it("a network allow makes reads behave like inside-cwd", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "default", store, cwd, rs)).toBe("allow");
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", store, cwd, rs)).toBe("allow");
  });

  it("a network allow makes edits follow mode logic instead of always asking", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "acceptEdits", store, cwd, rs)).toBe("allow");
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "default", store, cwd, rs)).toBe("ask");
  });

  it("an unmatched network path still asks in every mode", () => {
    const rs = netRules(["//other/share", "allow"], ["z:", "deny"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", store, cwd, rs)).toBe("ask");
    expect(decidePermission("Grep", { path: "//server/share" }, "default", store, cwd, rs)).toBe("ask");
  });

  it("a project-store deny wins over a network allow", () => {
    const rs = netRules(["//server/share", "allow"]);
    store.rememberDir("Read", "//server/share/private", "deny");
    expect(decidePermission("Read", { file_path: "//server/share/private/k.pem" }, "default", store, cwd, rs)).toBe("deny");
  });

  it("search tools honor network rules on their path input", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Glob", { path: "//server/share/src" }, "default", store, cwd, rs)).toBe("allow");
  });

  it("rules absent (undefined) preserves today's behavior", () => {
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", store, cwd)).toBe("ask");
  });
});
```

If the existing test file builds its `store`/`cwd` per-test rather than shared, mirror that pattern; the assertions above are what matters.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: FAIL — `decidePermission` ignores the 6th argument (unmatched-path expectations pass, deny/allow expectations fail).

- [ ] **Step 3: Implement**

In `src/engine/permissions.ts`:

Add import:

```ts
import { matchNetworkStorage, networkStorageRoot, type NetworkStorageRule } from "../agent/networkStorage.js";
```

Change the signature and the first block of `decidePermission` (lines 61–87 become):

```ts
export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  store: PermissionStore,
  cwd: string,
  networkStorage?: readonly NetworkStorageRule[]
): PermissionDecision {
  // Global network-storage rules are consulted before everything else: a
  // matching deny blocks even bypassPermissions, and a matching allow lets an
  // outside-cwd network path be treated as inside-cwd for every check below
  // (so reads auto-allow, edits follow acceptEdits, bypass allows). An
  // unmatched network path falls through to the normal forced-ask behavior.
  // Project-store dir rules still take precedence over a network allow in
  // every non-bypass flow because their check below runs earlier than the
  // final decisions.
  const scope = ruleScope(toolName, input);
  let networkAllows = false;
  if (scope && networkStorage && networkStorage.length > 0) {
    const ruling = matchNetworkStorage(networkStorage, scope.path);
    if (ruling === "deny") return "deny";
    networkAllows = ruling === "allow";
  }
  const outsideCwdFile =
    typeof input.file_path === "string" &&
    !isInsideCwd(input.file_path, cwd) &&
    !networkAllows;
```

Then update the two flags below to fold in `!networkAllows` the same way:

```ts
  const outsideCwdEdit = EDIT_TOOLS.has(toolName) && outsideCwdFile;
  const outsideCwdRead = toolName === "Read" && outsideCwdFile;
  const outsideCwdSearch =
    SEARCH_TOOLS.has(toolName) && typeof input.path === "string" &&
    !isInsideCwd(input.path, cwd) && !networkAllows;
```

Delete the now-duplicate `const scope = ruleScope(toolName, input);` at old line 90 (the store-rule block reuses the one declared above).

Everything else in the function stays untouched.

Add `networkRememberTarget` next to `hostScope` (it composes the same scoping helpers the overlay uses, preserving the documented decider/overlay invariant):

```ts
/**
 * The network-storage root a remembered rule for this tool call would be
 * written into global settings for, or undefined when the call does not name
 * a network path outside cwd (those are remembered as project dir rules as
 * before). Kept beside ruleScope/hostScope so the overlay's remember answer
 * and the decider agree on scoping.
 */
export function networkRememberTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string | undefined {
  const scope = ruleScope(toolName, input);
  if (!scope || isInsideCwd(scope.path, cwd)) return undefined;
  return networkStorageRoot(scope.path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-permissions.test.ts tests/networkStorage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/permissions.ts tests/engine-permissions.test.ts
git commit -m "feat(engine): consult networkStorage rules in decidePermission"
```

---

### Task 4: Wire rules through the loops

**Files:**
- Modify: `src/engine/loop.ts` (EngineOptions, ~line 27 and call at line 431)
- Modify: `src/agent/session.ts` (~line 181–209)
- Modify: `src/engine/tools/task.ts` (TaskToolDeps lines 19–34, sub-loop at ~line 62)
- Modify: `src/printMode.ts` (~line 82)
- Modify: `src/commands/cli/maintenanceExecutor.ts` (~line 29)

**Interfaces:**
- Consumes: `Settings.networkStorage` (Task 2); `decidePermission` 6th param (Task 3).
- Produces: every `EngineLoop` construction site passes `networkStorage`.

No new tests: this task is pure plumbing verified by the existing suites plus typecheck (behavior covered by Tasks 3 and 5).

- [ ] **Step 1: loop.ts — accept and pass the rules**

Add import near the other agent imports (line 6–7):

```ts
import type { NetworkStorageRule } from "../agent/networkStorage.js";
```

In `EngineOptions`, after `store: PermissionStore;` (line 27):

```ts
  /** Global network-storage allow/deny rules; undefined means no rules. */
  networkStorage?: NetworkStorageRule[];
```

At the `decidePermission` call (line 431), append the argument:

```ts
    let decision = decidePermission(block.name, block.input, this.mode, this.opts.store, this.opts.cwd, this.opts.networkStorage);
```

- [ ] **Step 2: session.ts — feed settings into the main loop**

`session.ts` already imports `loadSettings` (line 17). In the `new EngineLoop({...})` block (after `store,` at line 191):

```ts
      networkStorage: loadSettings().networkStorage,
```

In the `task:` deps object (after `store,` at line 171), also add:

```ts
        networkStorage: loadSettings().networkStorage,
```

- [ ] **Step 3: task.ts — pass rules into the subagent loop**

Add to the import block:

```ts
import type { NetworkStorageRule } from "../../agent/networkStorage.js";
```

Extend `TaskToolDeps` after `store: PermissionStore;`:

```ts
  networkStorage?: NetworkStorageRule[];
```

Extend the `SubagentDeps` `Pick<...>` union (line 33) to include `"networkStorage"`.

In `runSubagent`'s `new EngineLoop({...})` (after `store: deps.store,`):

```ts
    networkStorage: deps.networkStorage,
```

Then in `session.ts`'s `task:` deps object you added `networkStorage` in Step 2 — confirm the key name matches `TaskToolDeps.networkStorage`.

- [ ] **Step 4: printMode.ts and maintenanceExecutor.ts**

Both construct `EngineLoop` directly. In each file add:

```ts
import { loadSettings } from "./agent/settings.js";   // adjust relative path per file
```

(`maintenanceExecutor.ts` needs `"../agent/settings.js"`.)

And in each `new EngineLoop({...})` literal, after the `store` entry:

```ts
      networkStorage: loadSettings().networkStorage,
```

- [ ] **Step 5: Verify**

Run:
```bash
npx vitest run
npm run build
npm run lint
npm run lint:size
```
Expected: all PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/loop.ts src/agent/session.ts src/engine/tools/task.ts src/printMode.ts src/commands/cli/maintenanceExecutor.ts
git commit -m "feat(engine): thread networkStorage rules into every loop construction"
```

---

### Task 5: Remember network answers into global settings

**Files:**
- Modify: `src/ui/permissionController.ts`
- Modify: `src/ui/nativeApp.ts` (constructor at line 145)
- Modify: `tests/permissionController.test.ts`

**Interfaces:**
- Consumes: `networkRememberTarget` (Task 3); `saveNetworkStorageRule` (Task 2).
- Produces: `PermissionControllerDeps.cwd: string`; "always allow/deny" on an outside-cwd network path persists to `settings.json`.

- [ ] **Step 1: Write the failing tests**

The existing harness in `tests/permissionController.test.ts` builds the controller at lines 10–23 and answers "always allow" via the `"a"` hotkey. Mock the settings writer so no test touches real user config, add `cwd` to the deps, and append two tests after "reports a failed rule write without dropping the answer":

Top of file — extend imports and add the mock (must sit above the first import of the module under test so vitest hoists it):

```ts
import { describe, it, expect, vi } from "vitest";
// ...existing imports...
import { PermissionController } from "../src/ui/permissionController.js";

vi.mock("../src/agent/settings.js", () => ({ saveNetworkStorageRule: vi.fn() }));
import { saveNetworkStorageRule } from "../src/agent/settings.js";
```

Replace `setup()` with:

```ts
function setup() {
  const overlay = new OverlayManager();
  const store = new PermissionStore(mkdtempSync(join(tmpdir(), "cc-permctl-")));
  const cwd = mkdtempSync(join(tmpdir(), "cc-permctl-cwd-"));
  const errors: string[] = [];
  let queueEmptied = 0;
  const controller = new PermissionController({
    overlay,
    store,
    cwd,
    onError: t => { errors.push(t); },
    onQueueEmpty: () => { queueEmptied += 1; },
    recompute: () => {}
  });
  return { overlay, store, controller, errors, emptied: () => queueEmptied };
}
```

(The temp `cwd` keeps every existing test passing: paths like `/repo/src/a.ts` are outside it but not network paths, so they still route to `store.rememberDir`.)

New tests:

```ts
it("routes an outside-cwd network remember into global settings, not the project store", () => {
  const { overlay, store, controller } = setup();
  const answers: boolean[] = [];
  controller.enqueue(request("Write", { file_path: "//server/share/deep/f.txt" }, answers));
  overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
  expect(answers).toEqual([true]);
  expect(vi.mocked(saveNetworkStorageRule)).toHaveBeenCalledWith("//server/share", "allow");
  expect(store.list()).toEqual([]);
});

it("still remembers local paths in the project store without touching settings", () => {
  const { overlay, store, controller } = setup();
  const answers: boolean[] = [];
  controller.enqueue(request("Write", { file_path: "/repo/src/a.ts" }, answers));
  overlay.handleKey({ t: "printable", ch: "a" }, "a");
  expect(answers).toEqual([true]);
  expect(vi.mocked(saveNetworkStorageRule)).not.toHaveBeenCalled();
  expect(store.check("Write", "/repo/src/b.ts")).toBe("allow");
});
```

Add `beforeEach(() => { vi.mocked(saveNetworkStorageRule).mockClear(); });` inside the top-level `describe` so the two tests stay order-independent. Persistence into `settings.json` itself is already covered by `tests/settings.test.ts` (Task 2); these tests pin the routing decision.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/permissionController.test.ts`
Expected: FAIL — deps literal missing required `cwd`; network branch not implemented.

- [ ] **Step 3: Implement**

In `src/ui/permissionController.ts`:

Add imports:

```ts
import { hostScope, networkRememberTarget, ruleScope } from "../engine/permissions.js";
import { saveNetworkStorageRule } from "../agent/settings.js";
```

Extend `PermissionControllerDeps` (after `store: PermissionStore;`):

```ts
  /** Project cwd; decides whether a remembered path belongs in global
   * settings (network, outside cwd) or the project permission store. */
  cwd: string;
```

In `decide()`, insert a network branch between the host branch and the dir-scope branch (lines 42–55 become):

```ts
        const host = hostScope(active.toolName, active.input);
        if (host) {
          this.deps.store.rememberHost(active.toolName, host, rememberAs);
        } else {
          const netTarget = networkRememberTarget(active.toolName, active.input, this.deps.cwd);
          if (netTarget) {
            // Outside-cwd network paths are remembered globally, not in the
            // project store, so the approval travels with the machine rather
            // than one project.
            saveNetworkStorageRule(netTarget, rememberAs);
          } else {
            const scope = ruleScope(active.toolName, active.input);
            if (scope) {
              // "dir" inputs (Glob/Grep) already name the directory to scope to;
              // "file" inputs are scoped to their containing directory.
              if (scope.kind === "dir") this.deps.store.rememberDir(active.toolName, scope.path, rememberAs);
              else this.deps.store.remember(active.toolName, scope.path, rememberAs);
            } else if (active.toolName === "Bash" && typeof active.input.command === "string") {
              this.deps.store.rememberCommand(commandPrefix(String(active.input.command)), rememberAs);
            }
          }
        }
```

(The surrounding `try { ... } catch` already reports persist failures via `deps.onError`; `saveNetworkStorageRule` throwing lands there unchanged.)

In `src/ui/nativeApp.ts`, extend the `PermissionController` construction (lines 145–151) with:

```ts
      cwd: this.props.cwd,
```

Update any other `PermissionControllerDeps` literals (grep `new PermissionController` — currently only nativeApp.ts:145 and the test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/permissionController.test.ts tests/engine-permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run:
```bash
npm test
npm run build
npm run lint
npm run lint:size
```
Expected: all PASS.

```bash
git add src/ui/permissionController.ts src/ui/nativeApp.ts tests/permissionController.test.ts
git commit -m "feat(ui): remember network-path permissions in global settings"
```
