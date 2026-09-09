# Unified Soft Policy Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the three scattered path-confinement checks in `src/engine/permissions.ts` into one exported `classifyPath()` gate and extend it to `Bash` command strings via `extractBashPaths()`, with `PermissionStore` rules as the sole allow authority.

**Architecture:** No new files. `classifyPath()` (pure function, no I/O) owns the five-state classification `inside | owned | networkAllow | sensitive | outside`; `decidePermission()` keeps its existing order (network deny first, store deny-beats-allow, mode defaults last) and only swaps its inline predicates for `classifyPath()` plus a `bashOutside` flag. TDD throughout; every behavior change is pinned by a test before the code lands.

**Tech Stack:** TypeScript (strict), Node `node:path` (`resolve`, `sep`, `join`) + `node:os` (`homedir`), vitest, oxlint, `npm run lint:size` budget (permissions.ts is 201 lines; plan adds ~80).

**Working directory:** repo root (`D:\spider\working\cloudcode`). All commands run there. (Isolation via a git worktree per the using-git-worktrees skill is optional; the plan works in either.)

**File map:**
- Modify: `src/engine/permissions.ts` (add `PathClass`, `classifyPath`, `extractBashPaths`, rewire `decidePermission`)
- Modify: `tests/engine-permissions.test.ts` (349 lines; add ~70 lines of new tests, update 2 tests that pin old `Bash`-in-`bypassPermissions` behavior)
- Bump (every commit per repo policy): `src/version.ts`, `package.json`, `package-lock.json` (two fields), `installer/cloudcode.iss`

---

### Task 1: Add `classifyPath()` (pure, no behavior change)

**Files:**
- Modify: `src/engine/permissions.ts:1-6` (imports)
- Modify: `src/engine/permissions.ts:73-106` (insert after `isInsideCwd`/`isMemoryLocation`)
- Test: `tests/engine-permissions.test.ts:1-9` (imports)
- Test: `tests/engine-permissions.test.ts` (append new `describe` block at end)

Background the engineer needs: `decidePermission()` currently answers "is this path confined?" with three separate expressions combining `isInsideCwd()` (resolve+`sep` prefix match), `isMemoryLocation()` (everything under `configDir()` except `credentials.json`/`providers.json`, plus the project/user memory dirs), and `matchNetworkStorage()` (global UNC/drive allow/deny from `settings.json`). This task extracts that combination into one testable pure function. `decidePermission()` itself is NOT touched in this task, so all existing tests keep passing.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/engine-permissions.test.ts`:

```ts
import { decidePermission, hostScope, classifyPath } from "../src/engine/permissions.js";
```

(change line 2 to the above; rest of the import block unchanged), then append:

```ts
describe("classifyPath", () => {
  const OUT = join(tmpdir(), "cc-perm-outside", "f.txt");

  it("classifies inside-cwd paths", () => {
    expect(classifyPath(join(CWD, "src", "x.ts"), CWD)).toBe("inside");
    expect(classifyPath("relative/file.txt", CWD)).toBe("inside");
    expect(classifyPath("", CWD)).toBe("inside");
  });

  it("classifies cloudcode-owned paths", () => {
    expect(classifyPath(join(configDir(), "sessions", "s.jsonl"), CWD)).toBe("owned");
  });

  it("classifies credential files as sensitive even though they sit under the owned dir", () => {
    expect(classifyPath(join(configDir(), "credentials.json"), CWD)).toBe("sensitive");
    expect(classifyPath(join(configDir(), "providers.json"), CWD)).toBe("sensitive");
  });

  it("classifies plain outside paths", () => {
    expect(classifyPath(OUT, CWD)).toBe("outside");
  });

  it("classifies network-allowed paths", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(classifyPath("//server/share/f.txt", CWD, rs)).toBe("networkAllow");
    expect(classifyPath("//server/share/f.txt", CWD)).toBe("outside");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-permissions.test.ts -t "classifyPath"`
Expected: FAIL with `classifyPath is not a function` (or `does not provide an export named 'classifyPath'`).

- [ ] **Step 3: Write minimal implementation**

In `src/engine/permissions.ts`, change the import line 1 to:

```ts
import { isAbsolute, join, resolve, sep } from "node:path";
```

and add `import { homedir } from "node:os";` after the `memoryPaths.js` import (line 5). Then insert the following block immediately after the `isMemoryLocation` function (after line 106, before `export function decidePermission` on line 108):

```ts
export type PathClass = "inside" | "owned" | "networkAllow" | "sensitive" | "outside";

/**
 * Single policy gate for path confinement. Pure: resolves paths, reads no
 * disk. Precedence mirrors the old inline checks exactly: inside-cwd wins
 * first (a project-local file is never "sensitive"), then the two
 * credential files, then an explicit network allow, then the
 * cloudcode-owned config/memory dirs; anything else is outside.
 */
export function classifyPath(
  rawPath: string,
  cwd: string,
  networkStorage?: readonly NetworkStorageRule[]
): PathClass {
  const expanded =
    rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
      ? join(homedir(), rawPath.slice(1))
      : rawPath;
  const root = resolve(cwd);
  const target = resolve(cwd, expanded);
  if (target === root || target.startsWith(root + sep)) return "inside";
  if (
    target === resolve(configDir(), "credentials.json") ||
    target === resolve(configDir(), "providers.json")
  ) {
    return "sensitive";
  }
  if (
    networkStorage !== undefined &&
    networkStorage.length > 0 &&
    matchNetworkStorage(networkStorage, rawPath) === "allow"
  ) {
    return "networkAllow";
  }
  const base = resolve(configDir());
  if (target === base || target.startsWith(base + sep)) return "owned";
  if (target === resolve(userMemoryFile())) return "owned";
  const mem = resolve(memoryDir(cwd));
  if (target === mem || target.startsWith(mem + sep)) return "owned";
  return "outside";
}
```

Why the `~` expansion: `resolve()` does not expand tildes, so `~/x` would otherwise resolve to `<cwd>/~/x` and misclassify as `inside`. The network check receives the unexpanded `rawPath` because `matchNetworkStorage` does its own normalization.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: all tests PASS (new `classifyPath` block green, all 30+ existing tests still green — `decidePermission` untouched).

- [ ] **Step 5: Commit (with patch bump 0.1.47 -> 0.1.48)**

```bash
git add src/engine/permissions.ts tests/engine-permissions.test.ts
```

Apply the version bump (repo policy: every commit bumps patch in all four places together): in `src/version.ts` replace `export const VERSION = "0.1.47";` with `export const VERSION = "0.1.48";`; in `package.json` replace `  "version": "0.1.47",` with `  "version": "0.1.48",`; in `installer/cloudcode.iss` replace `#define AppVersion "0.1.47"` with `#define AppVersion "0.1.48"`; in `package-lock.json` replace both occurrences (`      "version": "0.1.47",` on line 3 and `  "version": "0.1.47",` on line 9) with `0.1.48` (the two `"version": "0.1.47",` strings with different indentation make each replacement unique — edit them one at a time).

```bash
git add src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(permissions): add classifyPath policy gate"
```

---

### Task 2: Rewire `decidePermission()` onto `classifyPath()` (refactor, zero behavior change)

**Files:**
- Modify: `src/engine/permissions.ts:116-153` (`decidePermission` head)
- Test: `tests/engine-permissions.test.ts` (no changes — existing suite is the safety net)

Background: this task deletes the `networkAllows`/`memoryAllows` locals and the three inline `outsideCwd*` predicates, replacing them with one `classifyPath()` call. The network-deny early return stays exactly where it is (deny beats everything, including `bypassPermissions`). If this refactor is faithful, the full existing suite passes unmodified.

- [ ] **Step 1: No new test (refactor task — existing suite is the net)**

State this explicitly in the commit message. Run the baseline first:

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Replace the confinement block**

Replace lines 121–153 of `src/engine/permissions.ts` (from `const scope = ruleScope(...)` through the `outsideCwdSearch` definition) with:

```ts
  const scope = ruleScope(toolName, input);
  if (scope && networkStorage && networkStorage.length > 0) {
    const ruling = matchNetworkStorage(networkStorage, scope.path);
    if (ruling === "deny") return "deny";
  }
  // Single gate: inside and owned/networkAllow paths are unconfined,
  // outside and sensitive paths are confined. A network allow surfaces as
  // "networkAllow" (unconfined), so no separate networkAllows flag is
  // needed; a network deny already returned above.
  const cls = scope === undefined ? undefined : classifyPath(scope.path, cwd, networkStorage);
  const confined = cls === "outside" || cls === "sensitive";
  const outsideCwdFile = typeof input.file_path === "string" && confined;
  const outsideCwdEdit = EDIT_TOOLS.has(toolName) && outsideCwdFile;
  // Reads are otherwise unconditionally allowed (see READ_ONLY below), but a
  // read resolving outside cwd is the primary data-exfiltration path for a
  // coding agent (e.g. ~/.ssh/id_rsa, ~/.aws/credentials) and so needs the
  // same cwd confinement as edits.
  const outsideCwdRead = toolName === "Read" && outsideCwdFile;
  // Same confinement for the search tools, which walk and read every file
  // under their `path`: unconfined, `Grep` over ~/.aws with a pattern like
  // "secret" is the same exfiltration path as a targeted Read, only broader.
  // An omitted (or empty) `path` means cwd, which is inside by definition.
  const outsideCwdSearch =
    SEARCH_TOOLS.has(toolName) && typeof input.path === "string" && confined;
```

Everything below line 153 (`if (mode === "bypassPermissions" ...` onward) stays byte-for-byte identical. Keep the two `// Reads are otherwise...` / `// Same confinement...` comments (moved with their predicates) so `git blame` context survives.

Equivalence notes the engineer must preserve (these are why the old suite passes unchanged):
1. `scope === undefined` (tools with no path input) → `confined` is `false`, same as the old `!isInsideCwd` short-circuit never firing.
2. Empty search `path: ""` → `classifyPath` resolves to `cwd` → `inside` → unconfined, same as before.
3. The `sensitive` state only fires for the two exact credential files, which the old code also confined (they sit outside cwd and were never `memoryAllows`).

- [ ] **Step 3: Run the full existing suite**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: PASS with zero test edits. If any test fails, the refactor is unfaithful — do not "fix" the test; fix the refactor.

- [ ] **Step 4: Run lint, size check, and build**

Run: `npm run lint`
Expected: no errors.
Run: `npm run lint:size`
Expected: `src/engine/permissions.ts` well under the ~600-line warning.
Run: `npm run build`
Expected: clean `tsc` emit.

- [ ] **Step 5: Commit (with patch bump 0.1.48 -> 0.1.49)**

```bash
git add src/engine/permissions.ts
```

Version bump: `0.1.48` → `0.1.49` in `src/version.ts` (`export const VERSION = "0.1.49";`), `package.json` (`  "version": "0.1.49",`), `installer/cloudcode.iss` (`#define AppVersion "0.1.49"`), `package-lock.json` (both indented occurrences).

```bash
git add src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "refactor(permissions): route confinement through classifyPath"
```

---

### Task 3: `extractBashPaths()` + `Bash` outside-path confinement (the behavior change)

**Files:**
- Modify: `src/engine/permissions.ts` (add `extractBashPaths`, add `bashOutside`, touch 2 lines)
- Test: `tests/engine-permissions.test.ts` (new `describe` block; update 2 tests pinning old behavior)

Background: `Bash` input has no `file_path`/`path`, so `ruleScope()` returns `undefined` and none of the confinement flags ever fire — in `bypassPermissions` every shell command auto-allows (see the `if (mode === "bypassPermissions" && ...)` short-circuit at what is now line ~155). This task extracts candidate paths from the command string, classifies each, and forces `ask` when any is confined — unless a matching `Bash` dir-rule `allow` covers it (store-first principle from the spec revision: the store is the sole allow authority). Prefix-deny keeps its existing priority (checked before the new `ask`).

Deliberately out of scope (spec non-goals): full shell parsing. The extractor covers Windows absolute (`C:\`, `C:/`), UNC (`\\server\share`), POSIX absolute (`/...`), `~/...` and bare `~`, `cd`/`chdir`/`pushd`/`Set-Location` targets (catches relative escapes like `cd ..`), and `>`/`>>` (with optional `2`) redirect targets. `Get-Content`/`cat` need no special case — their arguments are absolute paths the generic patterns already catch.

- [ ] **Step 1: Write the failing tests**

Update the import on line 2 to:

```ts
import { decidePermission, hostScope, classifyPath, extractBashPaths } from "../src/engine/permissions.js";
```

Update these 2 existing tests that pin the old behavior (old expectations noted in comments — delete the stale short-circuit comment on line 53):

Test at old line 22–24, change expectation `toBe("allow")` → `toBe("ask")`:

```ts
  it("bypassPermissions asks for Bash touching an outside path", () => {
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });
```

Test at old lines 87–91 (`"bypassPermissions still allows everything"` under `"Bash command rules"`): replace the whole test with:

```ts
  it("bypassPermissions defers to a remembered deny prefix when the command also leaves cwd", () => {
    const store = freshStore();
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", store, CWD)).toBe("deny");
  });
```

Append at end of file:

```ts
describe("Bash path confinement", () => {
  const OUT = join(tmpdir(), "cc-perm-outside", "loot.txt");

  it("bypassPermissions still allows a pathless command", () => {
    expect(decidePermission("Bash", { command: "ls" }, "bypassPermissions", freshStore(), CWD)).toBe("allow");
  });

  it("asks for absolute outside paths in every mode", () => {
    const store = freshStore();
    expect(decidePermission("Bash", { command: `cat ${OUT}` }, "default", store, CWD)).toBe("ask");
    expect(decidePermission("Bash", { command: `Get-Content ${OUT}` }, "acceptEdits", store, CWD)).toBe("ask");
    expect(decidePermission("Bash", { command: `cat ${OUT}` }, "bypassPermissions", store, CWD)).toBe("ask");
  });

  it("asks for redirect targets and directory escapes", () => {
    const store = freshStore();
    expect(decidePermission("Bash", { command: "echo hi > " + OUT }, "bypassPermissions", store, CWD)).toBe("ask");
    expect(decidePermission("Bash", { command: "cd .." }, "bypassPermissions", store, CWD)).toBe("ask");
  });

  it("a remembered prefix allow does not cover a command that leaves cwd", () => {
    const store = freshStore();
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: `git status > ${OUT}` }, "default", store, CWD)).toBe("ask");
  });

  it("a matching Bash dir-rule allow covers the outside path (store is the allow authority)", () => {
    const store = freshStore();
    store.rememberDir("Bash", join(tmpdir(), "cc-perm-outside"), "allow");
    expect(decidePermission("Bash", { command: `cat ${OUT}` }, "bypassPermissions", store, CWD)).toBe("allow");
  });

  it("extractBashPaths finds absolute, cd, and redirect targets", () => {
    expect(extractBashPaths("ls")).toEqual([]);
    expect(extractBashPaths(`cat ${OUT}`)).toContain(OUT);
    expect(extractBashPaths("cd ..")).toContain("..");
    expect(extractBashPaths("echo hi > " + OUT)).toContain(OUT);
  });
});
```

Note on `store.rememberDir("Bash", ...)`: `rememberDir` is public on `PermissionStore` (`src/agent/permissionStore.ts:101`) and `store.check("Bash", path)` already matches dir rules per tool name — no store change needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine-permissions.test.ts -t "Bash"`
Expected: FAIL — `extractBashPaths is not a function` (import error fails the file). If instead only expectations fail, that also confirms the tests pin new behavior; either failure mode is acceptable, but an import error must be the first thing seen.

- [ ] **Step 3: Implement `extractBashPaths`**

Insert before `export function decidePermission` (after `classifyPath`):

```ts
const BASH_PATH_PATTERNS = [
  /[A-Za-z]:[\\/][^\s"'|<>;&]*/g,
  /\\\\[^\s"'|<>;&]+/g,
  /(?:^|[\s"'=])(~(?:\/[^\s"'|<>;&]*)?|\/[^\s"'|<>;&]+)/gm,
];
const BASH_CD_RE =
  /(?:^|[;&|\n])\s*(?:cd|chdir|pushd|Set-Location)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|<>]+))/gim;
const BASH_REDIRECT_RE = /[12]?\s*>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s|<>;&]+))/g;

/**
 * Best-effort path candidates from a Bash/PowerShell command string.
 * Deliberately not a shell parser (see spec non-goals): covers absolute
 * paths, cd targets (including relative escapes like `..`), and redirect
 * targets. Each candidate is classified by the caller; non-paths that slip
 * through resolve inside cwd and are harmless.
 */
export function extractBashPaths(command: string): string[] {
  const found = new Set<string>();
  for (const re of BASH_PATH_PATTERNS) {
    for (const m of command.matchAll(re)) {
      found.add((m[1] ?? m[0]).trim().replace(/[,;:]+$/, ""));
    }
  }
  for (const re of [BASH_CD_RE, BASH_REDIRECT_RE]) {
    for (const m of command.matchAll(re)) {
      const token = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (token !== "") found.add(token);
    }
  }
  return [...found];
}
```

Regex notes for the engineer: the POSIX pattern's leading `(?:^|[\s"'=])` separator is non-captured so `m[1] ?? m[0]` yields the path without the separator; the `~` alternative matches bare `~` too (classified via the tilde expansion in `classifyPath`). The trailing `[,;:]+` strip never touches `.` so `..` survives. `matchAll` requires the `g` flag — all five regexes have it; the `BASH_CD_RE` additionally has `i` (PowerShell verbs are case-insensitive) and `m` (`^` per line for `cd` after `\n`).

- [ ] **Step 4: Wire `bashOutside` into `decidePermission`**

Three edits, all in `decidePermission`:

(a) After the confinement block from Task 2 (after the `outsideCwdSearch` definition), insert:

```ts
  // Bash names no path input, so ruleScope is undefined for it: extract
  // candidate paths from the command string and confine them like any
  // other path. A matching Bash dir-rule allow exempts a path (the store
  // stays the sole allow authority); prefix-deny already returned above.
  const bashPaths =
    toolName === "Bash" && typeof input.command === "string" ? extractBashPaths(input.command) : [];
  const bashOutside = bashPaths.some(path => {
    const c = classifyPath(path, cwd, networkStorage);
    if (c !== "outside" && c !== "sensitive") return false;
    return store.check("Bash", path) !== "allow";
  });
```

(b) Change the bypass short-circuit to:

```ts
  if (mode === "bypassPermissions" && !outsideCwdEdit && !outsideCwdRead && !outsideCwdSearch && !bashOutside) return "allow";
```

(c) Two changes in/after the prefix-rule block: change `if (ruling === "allow" && !compound) return "allow";` to `if (ruling === "allow" && !compound && !bashOutside) return "allow";`, and insert immediately after the closing brace of the `if (toolName === "Bash" ...)` prefix block (before the `if (toolName === "WebFetch")` block):

```ts
  // A Bash command reaching an outside/sensitive path with no covering
  // allow rule always asks — in default/acceptEdits this matches the
  // existing fallthrough, in bypassPermissions it closes the escape hatch.
  // A prefix deny already returned "deny" above and is never softened here.
  if (toolName === "Bash" && bashOutside) return "ask";
```

- [ ] **Step 5: Run the permission suite**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: PASS — new block green, the 2 updated tests green, everything else unchanged.

- [ ] **Step 6: Commit (with patch bump 0.1.49 -> 0.1.50)**

```bash
git add src/engine/permissions.ts tests/engine-permissions.test.ts
```

Version bump: in `src/version.ts` replace `export const VERSION = "0.1.49";` with `export const VERSION = "0.1.50";`; in `package.json` replace `  "version": "0.1.49",` with `  "version": "0.1.50",`; in `installer/cloudcode.iss` replace `#define AppVersion "0.1.49"` with `#define AppVersion "0.1.50"`; in `package-lock.json` replace `      "version": "0.1.49",` (line 3) with `      "version": "0.1.50",` and `  "version": "0.1.49",` (line 9) with `  "version": "0.1.50",`.

```bash
git add src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "feat(permissions): confine Bash commands with outside paths"
```

---

### Task 4: Full verification

**Files:** none (verification only; if anything fails, fix in a follow-up commit with its own patch bump, never amend).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS. Note: `tests/packaging.test.ts` asserts the four version locations agree — it passes only if every commit above bumped all four.

- [ ] **Step 2: Run lint, size, build**

Run: `npm run lint`
Expected: clean.
Run: `npm run lint:size`
Expected: `src/engine/permissions.ts` (~280 lines) and `tests/engine-permissions.test.ts` (~420 lines) both under the ~600-line warning.
Run: `npm run build`
Expected: clean `tsc` emit.

- [ ] **Step 3: Confirm version agreement**

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS (already covered by Step 1; run explicitly so the log shows it).
