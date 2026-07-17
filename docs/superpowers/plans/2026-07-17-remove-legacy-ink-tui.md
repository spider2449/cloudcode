# Remove Legacy Ink TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy Ink-based TUI (`src/ui/App.tsx` and everything only it depends on) from cloudcode, leaving the native TUI (`src/ui/nativeApp.ts`) as the sole UI, and remove the now-unused `ink`/`react` dependency stack.

**Architecture:** Four tasks: (1) simplify `src/cli.tsx` to always launch the native TUI and delete the `--tui` flag, (2) delete every Ink-only `.tsx` component and its dedicated tests, (3) trim the two genuinely shared files (`useGitStatus.ts`, which holds one Ink-only hook alongside the native `GitStatusPoller`) and delete Ink-only test files that test now-deleted components, (4) remove `ink`/`ink-spinner`/`react`/`ink-testing-library`/`react-devtools-core`/`@types/react` from `package.json`, drop the `jsx` compiler option from `tsconfig.json`, update `README.md`, and do a final full-repo verification (build + full test suite) that nothing still references Ink.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node >= 18, vitest, npm.

## Global Constraints

- All code comments must be in English.
- Imports between `src` files use the `.js` suffix, matching existing ESM style.
- Run tests with `npx vitest run <file>` (or `npx vitest run` for the whole suite); the only acceptable pre-existing failure in the full suite is the flaky provider test in `tests/app.test.tsx` — but that whole file is deleted by this plan, so after Task 2 the full suite must be **100% clean** with no whitelisted exceptions.
- This is a pure deletion/simplification task: do not refactor, rename, or "improve" surviving native-TUI code beyond what's needed to remove Ink references.
- Every task must end with `npm run build` succeeding and the targeted tests passing — do not defer the build check to the last task only.

---

### Task 1: Simplify `src/cli.tsx` to native-only, remove the `--tui` flag

`src/cli.tsx` currently branches on a `--tui` CLI flag between the native `App` (`src/ui/nativeApp.ts`) and the Ink-based `LegacyApp` (`src/ui/App.tsx`). This task removes the branch and the flag entirely, leaving only the native path. `src/ui/App.tsx` itself is deleted in Task 2 — this task must land first so nothing still imports it once it's gone.

**Files:**
- Modify: `src/cli.tsx` (full file shown below — this is the complete replacement)
- Delete: `tests/cli-args.test.ts` (tests only the now-removed `--tui` flag; it already mirrors `parseArgs` standalone rather than importing `cli.tsx`, per its own top comment, so no other test references it)
- Test: none new — this task removes a test file and no longer-relevant behavior

**Interfaces:**
- Consumes: `App` from `./ui/nativeApp.js` (`src/ui/nativeApp.ts`), `Terminal` from `./ui/term/terminal.js`, `loadProviders` from `./agent/providers.js`, `loadSettings` from `./agent/settings.js`, `SessionIndex` from `./agent/sessionIndex.js`, `VERSION` from `./version.js`, `loadCustomThemes` from `./ui/theme.js` — all unchanged signatures, already used by the native branch today.
- Produces: nothing new; `src/cli.tsx` no longer exports or references `LegacyApp`, `ink`, or `react`, and no longer accepts `--tui`.

- [ ] **Step 1: Confirm current test baseline**

Run: `npx vitest run tests/cli-args.test.ts`
Expected: PASS (2 tests) — this is the file being deleted; confirm it currently passes before removing it, so you know you're not masking an unrelated failure.

- [ ] **Step 2: Replace `src/cli.tsx` with the native-only version**

Replace the entire contents of `src/cli.tsx` with:

```tsx
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { App } from "./ui/nativeApp.js";
import { Terminal } from "./ui/term/terminal.js";
import { loadProviders } from "./agent/providers.js";
import { loadSettings } from "./agent/settings.js";
import { SessionIndex } from "./agent/sessionIndex.js";
import { VERSION } from "./version.js";
import { loadCustomThemes } from "./ui/theme.js";

// Custom themes must be registered before loadThemeName() validates the
// saved name, or a saved custom theme would silently fall back to dark.
for (const warning of loadCustomThemes()) console.error(warning);

const { values } = parseArgs({
  options: {
    continue: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    provider: { type: "string" },
    version: { type: "boolean", default: false }
  }
});

if (values.version) {
  console.log(`cloudcode ${VERSION}`);
  process.exit(0);
}

const providers = loadProviders();
const settings = loadSettings();
let providerName = values.provider ?? settings.provider ?? "anthropic";
if (!providers[providerName]) {
  if (values.provider) {
    console.error(`Unknown provider "${values.provider}". Known: ${Object.keys(providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
    process.exit(1);
  }
  console.error(`Saved default provider "${providerName}" not found; using anthropic.`);
  providerName = "anthropic";
}

const sessionIndex = new SessionIndex();
const initialCwd = process.cwd();
let resume: string | undefined;
if (values.continue) {
  resume = sessionIndex.latestForCwd(initialCwd)?.id;
  if (!resume) console.error("No previous session for this directory; starting fresh.");
}

const terminal = new Terminal();
const cleanupAndExit = (code: number) => { terminal.cleanup(); process.exit(code); };
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));
process.on("SIGHUP", () => cleanupAndExit(0));
process.on("uncaughtException", err => {
  terminal.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
  terminal.cleanup();
  throw err;
});

void (async () => {
  let cwd = initialCwd;
  let switchedFrom: string | undefined;
  let pendingResume = resume;
  let pendingOpenResume = values.resume;
  for (;;) {
    let switchTo: string | undefined;
    const app = new App({
      cwd,
      providers,
      initialProvider: providerName,
      initialModel: settings.model,
      initialMode: settings.permissionMode,
      resume: pendingResume,
      sessionIndex,
      openResumeOnStart: pendingOpenResume,
      switchedFrom,
      onSwitchProject: path => {
        try {
          process.chdir(path);
        } catch (err) {
          return `Failed to switch project: ${err instanceof Error ? err.message : String(err)}`;
        }
        switchTo = path;
        return undefined;
      }
    }, terminal);
    await app.run();
    if (!switchTo) break;
    switchedFrom = cwd;
    cwd = switchTo;
    pendingResume = undefined;
    pendingOpenResume = false;
  }
  terminal.cleanup();
})();
```

Note this file keeps the `.tsx` extension for now (Task 4 confirms whether it can become `.ts` once no JSX survives anywhere — do not rename it in this task, only in Task 4 after the full-repo check).

- [ ] **Step 3: Delete the now-obsolete flag test**

```bash
git rm tests/cli-args.test.ts
```

- [ ] **Step 4: Build and run the affected area**

Run: `npm run build`
Expected: compiles with no errors (this also transitively fails if `src/ui/App.tsx` or anything else still imports something removed — but at this point in the plan `App.tsx` still exists and is untouched, so this must be clean).

Run: `npx vitest run`
Expected: all tests pass except tests that reference `App.tsx`/Ink components, which are unaffected by this task (they're deleted in Task 2). Confirm no NEW failures were introduced beyond the pre-existing baseline (the `tests/app.test.tsx` flaky test may or may not fail here — that's expected and unrelated; it's deleted in Task 2 either way).

- [ ] **Step 5: Commit**

```bash
git add src/cli.tsx
git commit -m "refactor(cli): drop --tui flag and legacy Ink launch path

The native TUI has been the default and is now the only supported UI;
this removes the branch that could still launch the legacy Ink-based
App, in preparation for deleting that implementation entirely.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(The `tests/cli-args.test.ts` removal is included in the same commit via the staged `git rm` from Step 3 — `git add -u` or explicitly `git add tests/cli-args.test.ts` is not needed since `git rm` already staged the deletion; running `git status` before committing is a good sanity check but not a scripted step here.)

---

### Task 2: Delete every Ink-only component and its dedicated tests

This is the bulk deletion. Every file below imports from `"ink"` (or exists solely to support a file that does) and is not referenced by the native TUI. This was verified by tracing every importer of each file across `src/` — see the "Interfaces" section for the exact list confirmed to have zero non-Ink consumers.

**Files:**
- Delete: `src/ui/App.tsx`
- Delete: `src/ui/PermissionDialog.tsx`
- Delete: `src/ui/InputBox.tsx`
- Delete: `src/ui/MemoryPicker.tsx`
- Delete: `src/ui/MessageList.tsx`
- Delete: `src/ui/ProgressBar.tsx`
- Delete: `src/ui/ProjectPicker.tsx`
- Delete: `src/ui/ResumePicker.tsx`
- Delete: `src/ui/StatusBar.tsx`
- Delete: `src/ui/SuggestionMenu.tsx`
- Delete: `src/ui/WorkingIndicator.tsx`
- Delete: `src/ui/ThemeContext.tsx`
- Delete: `src/ui/bottomFill.ts` (only imported by `App.tsx`/`InputBox.tsx`; `src/ui/layout.ts` only *mentions* it in a comment, never imports it — confirmed by grep, no import statement)
- Delete: `tests/app.test.tsx`
- Delete: `tests/app.test.ts` (confirm before deleting — see Step 1; if this file tests something other than the Ink `App`, e.g. a shared helper, do NOT delete it and report the discrepancy instead of proceeding)
- Delete: `tests/inputBox.test.tsx`
- Delete: `tests/inputBox-width.test.ts` (confirm before deleting — see Step 1; only delete if it imports from `InputBox.tsx`)
- Delete: `tests/messageList.test.tsx`
- Delete: `tests/permissionDialog.test.tsx`
- Delete: `tests/projectPicker.test.tsx`
- Delete: `tests/resumePicker.test.tsx`
- Delete: `tests/statusBar.test.tsx`
- Delete: `tests/suggestionMenu.test.tsx`
- Delete: `tests/workingIndicator.test.tsx`
- Delete: `tests/memoryPicker.test.tsx`
- Delete: `tests/bottom-fill.test.ts` (imports `SuggestionMenu.js`, an Ink-only file being deleted)
- Delete: `tests/useGitStatus.test.tsx` (tests the Ink `useGitStatus` hook specifically; the separate `tests/useGitStatus.test.ts`, no `x`, tests only `GitStatusPoller` and is NOT touched by this task — see Task 3)

**Interfaces:**
- Consumes: none — this task only deletes files.
- Produces: after this task, nothing under `src/` imports `"ink"`, `"ink-spinner"`, or `"react"` except `src/ui/useGitStatus.ts` (handled in Task 3).

- [ ] **Step 1: Verify the two ambiguous test files before deleting them**

Two files in the delete list above have names similar to surviving native-TUI tests and must be individually confirmed, not deleted on assumption:

```bash
head -5 tests/app.test.ts
```
Confirm it imports `App` from `../src/ui/App.js` (the Ink component) — if instead it imports from `../src/ui/nativeApp.js`, STOP, do not delete it, and report this to the plan owner as a discrepancy (the native app's own test file may have a similarly generic name).

```bash
head -5 tests/inputBox-width.test.ts
```
Confirm it imports from `../src/ui/InputBox.js` (Ink) — if it imports from `../src/ui/widgets/inputBox.js` or `../src/ui/input.js` (native-side files, note the different paths), STOP, do not delete it, and report the discrepancy instead.

- [ ] **Step 2: Confirm the current full-suite baseline**

Run: `npx vitest run`
Expected: note the pass/fail counts (the pre-existing flaky `tests/app.test.tsx` test may fail — that's expected and about to be deleted). This is your "before" snapshot to compare against after deletion.

- [ ] **Step 3: Delete all confirmed files**

```bash
git rm src/ui/App.tsx src/ui/PermissionDialog.tsx src/ui/InputBox.tsx src/ui/MemoryPicker.tsx src/ui/MessageList.tsx src/ui/ProgressBar.tsx src/ui/ProjectPicker.tsx src/ui/ResumePicker.tsx src/ui/StatusBar.tsx src/ui/SuggestionMenu.tsx src/ui/WorkingIndicator.tsx src/ui/ThemeContext.tsx src/ui/bottomFill.ts
git rm tests/app.test.tsx tests/inputBox.test.tsx tests/messageList.test.tsx tests/permissionDialog.test.tsx tests/projectPicker.test.tsx tests/resumePicker.test.tsx tests/statusBar.test.tsx tests/suggestionMenu.test.tsx tests/workingIndicator.test.tsx tests/memoryPicker.test.tsx tests/bottom-fill.test.ts tests/useGitStatus.test.tsx
```

Only run `git rm tests/app.test.ts` and `git rm tests/inputBox-width.test.ts` if Step 1 confirmed they belong to the Ink stack; otherwise skip those two specifically.

- [ ] **Step 4: Build to surface any remaining reference to a deleted file**

Run: `npm run build`
Expected: FAIL if any surviving file still imports one of the deleted files — read the compiler error, it will name the importing file and the missing module. If it fails, that importing file was misclassified as Ink-only; stop and re-verify that file's actual consumers with `grep -rn "<deleted-file-basename>" src/` before deciding whether to also delete it or to keep it and remove only the specific import.

If the build fails because of `src/ui/useGitStatus.ts` still exporting the Ink `useGitStatus` hook that references a just-deleted type or file — that's expected, since Task 3 (not this task) removes that hook. Confirm the ONLY build errors are inside `useGitStatus.ts` itself (or none at all) before proceeding; any other file failing to compile is a real discrepancy.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: no failures caused by missing files (e.g. "Cannot find module"). If `tests/useGitStatus.test.tsx` was deleted in Step 3, its failures disappear; `tests/useGitStatus.test.ts` (kept) must still pass. Compare against the Step 2 baseline — the only differences should be the removal of the deleted files' tests (net fewer test files/tests, no new failures in survivors).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(ui): delete the legacy Ink TUI component tree

Removes App.tsx and every component that existed only to support it
(PermissionDialog, InputBox, MemoryPicker, MessageList, ProgressBar,
ProjectPicker, ResumePicker, StatusBar, SuggestionMenu,
WorkingIndicator, ThemeContext, bottomFill) along with their dedicated
tests. The native TUI (nativeApp.ts) is now the only UI.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Trim the shared `useGitStatus.ts` file down to native-only

`src/ui/useGitStatus.ts` contains two unrelated exports: a React hook `useGitStatus` (Ink-only, used only by the now-deleted `App.tsx`) and a `GitStatusPoller` class (used by `nativeApp.ts`). This task removes only the hook and its React import, keeping the class untouched.

**Files:**
- Modify: `src/ui/useGitStatus.ts`
- Test: `tests/useGitStatus.test.ts` (already exists, already tests only `GitStatusPoller` — must still pass unmodified after this task; do not edit this test file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GitStatusPoller` (class, unchanged public API) remains the sole export of `src/ui/useGitStatus.ts`; `nativeApp.ts`'s import of `GitStatusPoller` from this file is unaffected.

- [ ] **Step 1: Read the current file and confirm the hook/class boundary**

```bash
cat src/ui/useGitStatus.ts
```

Confirm the file has exactly one `import` line pulling from `"react"` (e.g. `useEffect`, `useState`) and one exported function named `useGitStatus` that uses those React hooks, plus a separately exported `GitStatusPoller` class (and a `GitExec` type) that does not reference React at all. If the actual file differs from this shape (e.g. the class internally calls the hook, or they share private helpers), STOP and report the actual structure rather than guessing at a split.

- [ ] **Step 2: Confirm the surviving test still passes before editing**

Run: `npx vitest run tests/useGitStatus.test.ts`
Expected: PASS — this is your baseline; this file must still pass, unmodified, after Step 3.

- [ ] **Step 3: Remove the Ink-only hook and its React import**

Delete the `import { useEffect, useState } from "react";` line (or equivalent React import) and the entire `useGitStatus` function export from `src/ui/useGitStatus.ts`, keeping `GitStatusPoller`, `GitExec`, and any other exports the class depends on (e.g. a shared `GitStatus` type) fully intact. Do not reformat or otherwise touch the surviving code.

- [ ] **Step 4: Run the surviving test again**

Run: `npx vitest run tests/useGitStatus.test.ts`
Expected: PASS, identical to Step 2's result — confirms the trim didn't disturb `GitStatusPoller`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: compiles clean — confirms nothing else in the codebase still imported the now-deleted `useGitStatus` hook (it shouldn't, since its only consumer, `App.tsx`, was deleted in Task 2).

- [ ] **Step 6: Commit**

```bash
git add src/ui/useGitStatus.ts
git commit -m "refactor(ui): remove the Ink-only useGitStatus hook

Its only consumer, App.tsx, was deleted in the previous commit.
GitStatusPoller (used by the native TUI) is unaffected.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Remove Ink/React dependencies, drop `jsx` config, update README, final verification

With every Ink-only source and test file gone, this task removes the now-dead dependencies from `package.json`, drops the TypeScript `jsx` compiler option (no `.tsx` file should require JSX transform anymore, since only `src/cli.tsx` and `src/ui/nativeApp.ts`'s test doubles remain and neither uses JSX syntax — this task keeps `cli.tsx`'s `.tsx` extension as-is per Task 1's note, but verifies no JSX syntax survives, which is what actually requires the compiler flag, not the extension itself), updates `README.md`'s now-inaccurate `--tui=legacy` documentation, and does one final full-repo sanity check.

**Files:**
- Modify: `package.json` (remove `ink`, `ink-spinner`, `react` from `dependencies`; remove `@types/react`, `ink-testing-library`, `react-devtools-core` from `devDependencies`)
- Modify: `tsconfig.json` (remove the `"jsx": "react-jsx"` line)
- Modify: `README.md:128-129` (remove the two lines documenting `--tui=legacy`)
- Test: full suite (`npx vitest run`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new; this is the final cleanup task for this plan.

- [ ] **Step 1: Confirm no source file still imports react/ink before touching package.json**

```bash
grep -rn "from \"react\"\|from \"ink\"\|from \"ink-spinner\"" src/
```
Expected: no output. If anything appears, STOP — do not proceed with dependency removal until every reference is gone (go back and delete/trim the offending file first; this indicates Task 2 or 3 missed something).

```bash
grep -rln "ink-testing-library" tests/
```
Expected: no output. If anything appears, that test file was missed in Task 2 — delete it now as part of this task and note it in the commit message.

- [ ] **Step 2: Edit `package.json`**

Remove these three lines from `"dependencies"`:
```
    "ink": "^5.2.1",
    "ink-spinner": "^5.0.0",
    "react": "^18.3.1"
```
(leaving `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `marked`, `marked-terminal` as the remaining dependencies — verify the trailing commas are fixed up so the JSON stays valid, i.e. `marked-terminal` becomes the new last entry with no trailing comma).

Remove these three lines from `"devDependencies"`:
```
    "@types/react": "^19.2.17",
    "ink-testing-library": "^4.0.0",
    "react-devtools-core": "^4.28.5",
```
(leaving `@types/marked-terminal`, `@types/node`, `tsx`, `typescript`, `vitest` — again fix up trailing commas so the JSON remains valid).

- [ ] **Step 3: Reinstall to update the lockfile**

Run: `npm install`
Expected: exits 0, `package-lock.json` is updated to drop the removed packages and their sub-dependencies (e.g. `ink`'s own dependency tree).

- [ ] **Step 4: Remove the `jsx` compiler option from `tsconfig.json`**

Change `tsconfig.json` from:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```
to:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Update `README.md`**

Remove these two lines (currently at `README.md:128-129`):
```
The legacy Ink-based UI remains available with `npm run dev -- --tui=legacy`
(or `cloudcode --tui=legacy`); the native TUI is the default.
```
Read the surrounding paragraph first (a few lines above and below) to confirm you're removing exactly this note and not accidentally leaving a dangling sentence fragment or an orphaned heading — adjust adjacent punctuation/line breaks only as needed for the paragraph to still read correctly with the note gone.

- [ ] **Step 6: Full build and test verification**

Run: `npm run build`
Expected: compiles with zero errors. If it fails on JSX syntax (e.g. `error TS17004: Cannot use JSX unless the '--jsx' flag is provided`), that means a `.tsx` file still contains actual JSX markup — find it with `grep -rln "</\|/>" src/*.tsx src/**/*.tsx 2>/dev/null` (excluding plain generic-syntax `>` false positives by eye) and report it; do not silently restore the `jsx` flag without understanding why a file still needs it, since that would mean Task 2 missed a file.

Run: `npx vitest run`
Expected: **all tests pass, zero failures** — the plan's earlier tasks tolerated the known-flaky `tests/app.test.tsx` test only because that file still existed; it's deleted as of Task 2, so this final run must be completely clean with no exceptions.

Run: `npm run dev -- --version`
Expected: prints `cloudcode <version>` and exits 0 — a smoke test that the native-only `cli.tsx` still boots correctly post-dependency-removal (this exercises the early-exit path before any TTY/Terminal setup, so it's safe to run non-interactively).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json README.md
git commit -m "chore: remove ink/react dependencies now that the Ink TUI is gone

Drops ink, ink-spinner, react, @types/react, ink-testing-library, and
react-devtools-core; removes the now-unused jsx compiler option; and
updates README to drop the --tui=legacy note.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
