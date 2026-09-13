# Desktop Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move root `desktop/` (renderer, shell, vite config) into `src/desktop/` so the repo has exactly one desktop home, with byte-identical `dist/` output.

**Architecture:** `git mv` the 18 files (backend 18 files untouched), shrink renderer cross-root imports by one level, re-anchor shell path arithmetic and build/packaging strings, then update test paths. Three sequential commits; the full suite is red after Tasks 1–2 by construction (tests still point at old paths) and green after Task 3 — do NOT push until all three land.

**Tech Stack:** TypeScript 7 (strict), Vite + React 19, Electron shell (plain JS), electron-builder, vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-desktop-relocation-design.md`

## Global Constraints

- `dist/` output frozen: `dist/cli.js` and `dist/desktop/*` keep identical names. No behavior or logic changes anywhere — moves plus path-string rewrites only.
- Every commit bumps the patch version in all four places (`src/version.ts`, `package.json`, `package-lock.json` × 2, `installer/cloudcode.iss`); tasks run in order, starting version is `0.1.126`.
- Do NOT push to origin until all three tasks land (Tasks 1–2 leave `npm test` red by construction).
- Move with `git mv` (history preserved). Backend files under `src/desktop/` are never touched.
- Historical files under `docs/superpowers/specs|plans/` are frozen and keep old paths.
- `tsconfig.json` keeps `"strict": true`; no `: any`, no `!` assertions.

---

## File Structure

After all tasks, `src/desktop/` holds: 18 untouched backend files at top level, `renderer/` (15 files), `shell/` (`main.mjs`, `preload.cjs`), `vite.config.ts`. Root `desktop/` is gone (tracked files moved; ignored `desktop/dist/` removed from disk). New build output (gitignored) is `src/desktop/dist/`.

---

### Task 1: Move the files, fix renderer imports and configs (0.1.127)

**Files:**
- Move (git mv): `desktop/renderer/bridge.ts`, `busySessions.ts`, `chatHelpers.ts`, `chatPane.tsx`, `gitPanel.tsx`, `index.html`, `inputHistory.ts`, `lastSelection.ts`, `src.tsx`, `statusBar.tsx`, `style.css`, `themeMenu.tsx`, `themeState.ts`, `vite-env.d.ts`, `workspaceView.ts` → `src/desktop/renderer/`; `desktop/main.mjs` → `src/desktop/shell/main.mjs`; `desktop/preload.cjs` → `src/desktop/shell/preload.cjs`; `desktop/vite.config.ts` → `src/desktop/vite.config.ts`
- Modify: the 5 renderer files with cross-root imports (8 statements), `src/desktop/vite.config.ts`, `tsconfig.desktop.json`, `.gitignore`
- Modify (version bump to `0.1.127`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: new tree layout plus green `typecheck:desktop`, green vite build emitting `src/desktop/dist/index.html`, green `lint`. Full `npm test` stays red until Task 3 (tests still reference old paths) — expected, do not fix here.

- [ ] **Step 1: Move all 18 files with git mv**

Run from the repo root. `git mv` does not create leading destination
directories, so create them first:

```bash
New-Item -ItemType Directory -Path "src/desktop/renderer" -Force
New-Item -ItemType Directory -Path "src/desktop/shell" -Force
```

```bash
git mv desktop/renderer/bridge.ts src/desktop/renderer/bridge.ts
git mv desktop/renderer/busySessions.ts src/desktop/renderer/busySessions.ts
git mv desktop/renderer/chatHelpers.ts src/desktop/renderer/chatHelpers.ts
git mv desktop/renderer/chatPane.tsx src/desktop/renderer/chatPane.tsx
git mv desktop/renderer/gitPanel.tsx src/desktop/renderer/gitPanel.tsx
git mv desktop/renderer/index.html src/desktop/renderer/index.html
git mv desktop/renderer/inputHistory.ts src/desktop/renderer/inputHistory.ts
git mv desktop/renderer/lastSelection.ts src/desktop/renderer/lastSelection.ts
git mv desktop/renderer/src.tsx src/desktop/renderer/src.tsx
git mv desktop/renderer/statusBar.tsx src/desktop/renderer/statusBar.tsx
git mv desktop/renderer/style.css src/desktop/renderer/style.css
git mv desktop/renderer/themeMenu.tsx src/desktop/renderer/themeMenu.tsx
git mv desktop/renderer/themeState.ts src/desktop/renderer/themeState.ts
git mv desktop/renderer/vite-env.d.ts src/desktop/renderer/vite-env.d.ts
git mv desktop/renderer/workspaceView.ts src/desktop/renderer/workspaceView.ts
git mv desktop/main.mjs src/desktop/shell/main.mjs
git mv desktop/preload.cjs src/desktop/shell/preload.cjs
git mv desktop/vite.config.ts src/desktop/vite.config.ts
```

- [ ] **Step 2: Shrink the 8 cross-root imports by one level**

`src/desktop/renderer/` is one level closer to `src/` than before. All `./` sibling imports are untouched. Apply these exact replacements:

In `src/desktop/renderer/chatPane.tsx`:

```tsx
import { GUI_SLASH_NAMES } from "../../commands/guiSlashNames.js";
```

(replaces `"../../src/commands/guiSlashNames.js"`)

In `src/desktop/renderer/src.tsx`:

```tsx
import { VERSION } from "../../version.js";
import type { DesktopStatusPayload } from "../statusPayload.js";
```

(replacing `"../../src/version.js"` and `"../../src/desktop/statusPayload.js"`)

In `src/desktop/renderer/statusBar.tsx`:

```tsx
import { STATUS_LINE_ITEMS, STATUS_LINE_LABELS } from "../../statusLineItems.js";
import { formatStatusSegments, type DesktopStatusPayload } from "../statusPayload.js";
```

(replacing `"../../src/statusLineItems.js"` and `"../../src/desktop/statusPayload.js"`)

In `src/desktop/renderer/themeMenu.tsx`:

```tsx
import { THEMES } from "../../ui/builtinThemes.js";
import { themeMenuItems } from "../appMenu.js";
```

(replacing `"../../src/ui/builtinThemes.js"` and `"../../src/desktop/appMenu.js"`)

In `src/desktop/renderer/themeState.ts`:

```tsx
import { THEMES } from "../../ui/builtinThemes.js";
```

(replacing `"../../src/ui/builtinThemes.js"`)

- [ ] **Step 3: Re-anchor the vite config, tsconfig include, and gitignore**

In `src/desktop/vite.config.ts`, replace `root: "desktop/renderer"` with `root: "src/desktop/renderer"`. `outDir: "../dist"` is unchanged and now lands at `src/desktop/dist/`.

In `tsconfig.desktop.json`, replace `"include": ["desktop/renderer"]` with `"include": ["src/desktop/renderer"]`. Nothing else in that file changes.

In `.gitignore`, replace `desktop/dist/` with `src/desktop/dist/`.

- [ ] **Step 4: Verify typecheck, vite build, and lint**

Run: `npm run typecheck:desktop`
Expected: PASS (exit 0).

Run: `npx vite build --config src/desktop/vite.config.ts`
Expected: PASS with `src/desktop/dist/index.html` emitted. Confirm with `Test-Path src/desktop/dist/index.html` (must be True).

Run: `npm run lint`
Expected: PASS (exit 0).

- [ ] **Step 5: Confirm backend tests still pass (nothing else broke)**

Run: `npx vitest run tests/desktop-gitService.test.ts tests/desktop-shellHost.test.ts tests/desktop-guiServer.test.ts`
Expected: PASS. (Backend imports are untouched, so these prove the move disturbed nothing outside the renderer.)

- [ ] **Step 6: Remove the stale on-disk leftovers**

Root `desktop/` now holds only empty dirs plus the ignored stale `desktop/dist/`. After Step 4 passes, remove them so nothing reads the old output again:

```bash
Remove-Item -Recurse -Force desktop
```

Verify: `Test-Path desktop` is False.

- [ ] **Step 7: Bump version to `0.1.127` and commit (do NOT push)**

Replace `0.1.126` with `0.1.127` in `src/version.ts` (`VERSION`), `package.json` (`"version"`), `package-lock.json` (both `"version"` lines — top-level and `packages[""]`), `installer/cloudcode.iss` (`#define AppVersion`).

```bash
git add -A
git status --short
git commit -m "refactor(desktop): move renderer and shell into src/desktop (0.1.127)"
```

`git add -A` also sweeps in this untracked plan file — intended (the plan travels with its implementation, same as the governance plan). Before committing, `git status` must show renames under `src/desktop/` plus the four version files plus the three config edits plus this plan file — and no other modifications. After the bump, re-run `npx vitest run tests/packaging.test.ts` (must pass: it pins the version agreement on the committed numbers) before committing. Full `npm test` is red at this commit by construction (tests still reference old paths); Task 3 greens it. Do NOT push.

---

### Task 2: Shell path arithmetic plus build/packaging wiring (0.1.128)

**Files:**
- Modify: `src/desktop/shell/main.mjs` (imports, projectRoot, resolveCliPath candidates, loadFile)
- Modify: `package.json` (`main`, `desktop:build`, `desktop:start`, `build.files` × 3)
- Modify: `scripts/desktop-package.mjs` (vite config path, dist existence check + message)
- Modify: `AGENTS.md` (single-desktop bullets), `scripts/check-file-size.mjs` (drop `"desktop"` from ROOTS)
- Modify (version bump to `0.1.128`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: new tree layout from Task 1.
- Produces: working `desktop:build`/`desktop:dist`/`desktop:package` scripts, correct packaged-path arithmetic in the shell, updated contributor docs. Full `npm test` still red until Task 3.

- [ ] **Step 1: Fix shell imports**

In `src/desktop/shell/main.mjs`, replace:

```js
import { DesktopShellHost } from "../dist/desktop/shellHost.js";
import { requireBranchName, requirePaths, requireString } from "../dist/desktop/ipcContract.js";
import { resolveNodeExecutable } from "../dist/desktop/runtime.js";
import { VERSION } from "../dist/version.js";
```

with:

```js
import { DesktopShellHost } from "../../../dist/desktop/shellHost.js";
import { requireBranchName, requirePaths, requireString } from "../../../dist/desktop/ipcContract.js";
import { resolveNodeExecutable } from "../../../dist/desktop/runtime.js";
import { VERSION } from "../../../dist/version.js";
```

- [ ] **Step 2: Fix projectRoot derivation**

In `src/desktop/shell/main.mjs`, replace:

```js
const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: desktop/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is one level above desktop/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..");
```

with:

```js
const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: src/desktop/shell/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is three levels above src/desktop/shell/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..", "..", "..");
```

The `.asar` branch is untouched (frozen `dist/` guarantees it).

- [ ] **Step 3: Fix resolveCliPath dev candidates and the renderer loadFile**

In `src/desktop/shell/main.mjs`, replace:

```js
  candidates.push(join(desktopDir, "..", "dist", "cli.js"));
```

with:

```js
  candidates.push(join(desktopDir, "..", "..", "..", "dist", "cli.js"));
```

(The `projectRoot`-based candidate on the next line is untouched — `projectRoot` itself was fixed in Step 2.)

Replace:

```js
  else void window.loadFile(join(desktopDir, "dist", "index.html"));
```

with:

```js
  else void window.loadFile(join(desktopDir, "..", "dist", "index.html"));
```

The `preload: join(desktopDir, "preload.cjs")` line is untouched (still a sibling). `preload.cjs` itself needs zero edits (no relative paths).

- [ ] **Step 4: Update package.json entry points and file list**

Replace `"main": "desktop/main.mjs",` with `"main": "src/desktop/shell/main.mjs",`.

Replace `"desktop:build": "npm run build && vite build --config desktop/vite.config.ts",` with `"desktop:build": "npm run build && vite build --config src/desktop/vite.config.ts",`.

Replace `"desktop:start": "npm run desktop:build && electron desktop/main.mjs",` with `"desktop:start": "npm run desktop:build && electron src/desktop/shell/main.mjs",`.

In `build.files`, replace the three entries `"desktop/dist/**"`, `"desktop/preload.cjs"`, `"desktop/main.mjs"` with `"src/desktop/dist/**"`, `"src/desktop/shell/preload.cjs"`, `"src/desktop/shell/main.mjs"`. (`directories.output release/desktop` is untouched, so smoke-test globs hold.)

- [ ] **Step 5: Update the orchestrator script and size check**

In `scripts/desktop-package.mjs`, replace `run("npx vite build --config desktop/vite.config.ts");` with `run("npx vite build --config src/desktop/vite.config.ts");`, and replace both `desktop/dist/index.html` strings (the `existsSync` check and the error message) with `src/desktop/dist/index.html`.

In `scripts/check-file-size.mjs`, replace `const ROOTS = ["src", "tests", "desktop"];` with `const ROOTS = ["src", "tests"];` (renderer stays covered under `src`).

- [ ] **Step 6: Rewrite the AGENTS.md desktop section**

Replace the two bullets:

```md
- **`src/desktop/`** — the GUI backend (TypeScript, compiled into `dist/`
  by the main `tsconfig.json`): the `--gui-server` logic, shell host, git
  service, IPC contract. It stays UI-framework-free (no DOM/React) so the
  TUI build and node-based unit tests keep working.
- **`desktop/`** — the Electron shell and web UI, outside the main
  `tsconfig.json`: `main.mjs` + `preload.cjs` (plain JS, covered by oxlint)
  and `desktop/renderer/` (Vite+React DOM code, typechecked by
  `tsconfig.desktop.json` via `npm run typecheck:desktop`). Cross-root
  imports into `src/` (`../../src/*.js`) are allowed only for leaf modules
  (version, theme data, status payloads, slash-name lists) — never for
  `engine/` or `agent/` state.
```

with:

```md
- **`src/desktop/`** — everything desktop, in three areas: the GUI
  backend flat at the top (TypeScript, compiled into `dist/` by the main
  `tsconfig.json`: the `--gui-server` logic, shell host, git service,
  IPC contract — stays UI-framework-free, no DOM/React, so the TUI
  build and node-based unit tests keep working), `renderer/` (Vite+React
  DOM code, typechecked by `tsconfig.desktop.json` via
  `npm run typecheck:desktop`), and `shell/` (`main.mjs` + `preload.cjs`,
  plain JS covered by oxlint). Cross-root imports into `src/`
  (`../../*.js` from `renderer/`) are allowed only for leaf modules
  (version, theme data, status payloads, slash-name lists) — never for
  `engine/` or `agent/` state.
```

- [ ] **Step 7: Verify shell syntax, builds, and frozen dist output**

Run: `node --check src/desktop/shell/main.mjs` and `node --check src/desktop/shell/preload.cjs`
Expected: both PASS (no output).

Run: `npm run build`
Expected: PASS.

Run: `npm run desktop:build`
Expected: PASS with `src/desktop/dist/index.html` present.

Run: `node dist/cli.js --version`
Expected: prints `cloudcode 0.1.127` (proves the frozen entry point; exits before any provider/network code). Use `0.1.127` here — the bump to `0.1.128` happens in Step 8 after verification.

Confirm the frozen layout: `dist/cli.js`, `dist/desktop/shellHost.js`, `dist/desktop/guiBackend.js`, and `dist/desktop/ipcContract.js` must all exist (same names as pre-move).

Full `npm test` is still red at this point (test paths move in Task 3) — expected, do not fix here.

- [ ] **Step 8: Bump version to `0.1.128` and commit (do NOT push)**

Replace `0.1.127` with `0.1.128` in the same four version files as Task 1 Step 7.

```bash
git add src/desktop/shell/main.mjs package.json scripts/desktop-package.mjs AGENTS.md scripts/check-file-size.mjs src/version.ts package-lock.json installer/cloudcode.iss
git commit -m "refactor(desktop): rewire shell paths and packaging to src/desktop (0.1.128)"
```

`git status` must show only these files modified. After the bump, re-run `npx vitest run tests/packaging.test.ts` (must pass on the committed numbers) before committing. Do NOT push.

---

### Task 3: Update test paths and packaging contract (0.1.129)

**Files:**
- Modify (path rewrites only, zero logic changes): every test file referencing old `desktop/` paths — `tests/desktop-chatHelpers.test.ts`, `tests/desktop-busySessions.test.ts`, `tests/desktop-chatPane.test.ts`, `tests/desktop-chatParity.test.ts`, `tests/desktop-gitPanel.test.ts`, `tests/desktop-inputHistory.test.ts`, `tests/desktop-lastSelection.test.ts`, `tests/desktop-themeMenu.test.ts`, `tests/desktop-themeCss.test.ts`, `tests/desktop-themeState.test.ts`, `tests/desktop-workspaceView.test.ts`, `tests/packaging.test.ts`
- Modify (version bump to `0.1.129`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: moved tree (Task 1) and rewired build (Task 2).
- Produces: fully green suite on the new layout; root `desktop/` provably gone. After this task, pushing is safe.

- [ ] **Step 1: Rewrite renderer module imports in tests**

In each test file under `tests/`, replaceAll `../desktop/renderer/` with `../src/desktop/renderer/`. This string matches only renderer imports (backend test imports already read `../src/desktop/` and are untouched). Affected files: `desktop-chatHelpers`, `desktop-busySessions`, `desktop-gitPanel`, `desktop-inputHistory`, `desktop-lastSelection`, `desktop-themeMenu`, `desktop-themeCss`, `desktop-themeState`, `desktop-workspaceView` test files.

- [ ] **Step 2: Rewrite readFileSync path strings in tests**

Apply these exact replaceAll pairs across `tests/` (covers `desktop-chatPane.test.ts`, `desktop-chatParity.test.ts`, `desktop-themeCss.test.ts`):

- `"desktop/renderer/` → `"src/desktop/renderer/`
- `` `desktop/renderer/${file}` `` → `` `src/desktop/renderer/${file}` ``
- `"desktop/main.mjs"` → `"src/desktop/shell/main.mjs"`
- `"desktop/preload.cjs"` → `"src/desktop/shell/preload.cjs"`

- [ ] **Step 3: Update the packaging contract assertions**

In `tests/packaging.test.ts`, replace:

```ts
    for (const pattern of ["dist/**", "desktop/dist/**", "desktop/preload.cjs"]) {
```

with:

```ts
    for (const pattern of ["dist/**", "src/desktop/dist/**", "src/desktop/shell/preload.cjs"]) {
```

Replace `expect(read("desktop/main.mjs")).toContain("app.asar.unpacked");` with `expect(read("src/desktop/shell/main.mjs")).toContain("app.asar.unpacked");`.

Replace `expect(read("scripts/desktop-package.mjs")).toContain("desktop/dist");` with `expect(read("scripts/desktop-package.mjs")).toContain("src/desktop/dist");`.

- [ ] **Step 4: Prove no stale references remain**

Run: `grep -rn "desktop/renderer\|desktop/main\.mjs\|desktop/preload\|desktop/dist\|\"desktop" tests/ package.json scripts/ .github/ AGENTS.md .gitignore tsconfig.desktop.json`
Expected: zero matches. (Historical files under `docs/superpowers/` are frozen and exempt — do not touch them.)

- [ ] **Step 5: Run the full gate**

Run in order, expecting PASS throughout (size check: zero warnings):

```bash
npm run lint
npm run lint:size
npm run build
npm run typecheck:desktop
npm run desktop:build
npm test
```

Expected: all green; `npm test` fully passes including `packaging.test.ts` (validates the bumped version agreement) and the filename-pinned `chatParity` assertions in equal count.

- [ ] **Step 6: Confirm the old root is gone, bump to `0.1.129`, and commit**

Confirm `Test-Path desktop` is False and `git status --short` shows modifications only under `src/desktop/`, `tests/`, `scripts/`, `AGENTS.md`, `package.json`, plus the four version files.

Replace `0.1.128` with `0.1.129` in the same four version files.

```bash
git add tests src/desktop package.json scripts/desktop-package.mjs scripts/check-file-size.mjs AGENTS.md src/version.ts package-lock.json installer/cloudcode.iss .gitignore tsconfig.desktop.json
git commit -m "refactor(desktop): point tests and packaging at src/desktop (0.1.129)"
```

After the bump, re-run `npx vitest run tests/packaging.test.ts` (must pass on the committed numbers) before committing. After this commit the tree is whole and green. Report back; pushing stays the human partner's explicit decision (do not push unasked).
