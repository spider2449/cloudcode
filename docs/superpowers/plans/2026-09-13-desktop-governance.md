# Desktop Governance Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `desktop/` under the same typecheck, lint, size-ceiling, and CI governance as `src/` without moving any files.

**Architecture:** Fix the 7 strict-mode type errors a probe found in `desktop/renderer` today, add a dedicated `tsconfig.desktop.json` (main `tsconfig.json` untouched so `dist/` layout never changes), then widen `oxlint`, `lint:size`, CI, and `AGENTS.md` to cover `desktop/`.

**Tech Stack:** TypeScript 7 (strict), oxlint, Vite + React 19 renderer, Electron shell (`main.mjs` / `preload.cjs`), GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-13-desktop-governance-design.md`

## Global Constraints

- `tsconfig.json` keeps `"strict": true`; no `: any`, no `!` assertions in new/edited code (a ternary narrowing is used instead of a cast in Task 1).
- No file moves, no import-path changes, no splitting of `src.tsx` / `chatPane.tsx`.
- Every commit bumps the patch version in all four places (`src/version.ts`, `package.json`, `package-lock.json` × 2, `installer/cloudcode.iss`); tasks run in order so version strings below are exact.
- `main.mjs` / `preload.cjs` stay plain JS (no `checkJs`); oxlint covers them.
- Starting version for this plan is `0.1.118` (spec commit `6719650`).

---

## File Structure

- Modify: `desktop/renderer/chatPane.tsx` — three behavior-preserving strict-mode fixes (two `useRef` declarations, one `role` narrowing, one `scope` shape fix).
- Create: `desktop/renderer/vite-env.d.ts` — one line referencing `vite/client` types so the `style.css` side-effect import resolves.
- Create: `tsconfig.desktop.json` — standalone renderer typecheck config, `noEmit`, `include: ["desktop/renderer"]` only.
- Modify: `package.json` — add `typecheck:desktop` script; widen `lint` to `oxlint src tests desktop`.
- Modify: `scripts/check-file-size.mjs` — `ROOTS` gains `"desktop"`, `EXTENSIONS` gains `".cjs"`.
- Modify: `.github/workflows/ci.yml` — `build-and-test` gains desktop typecheck + `desktop:build` steps.
- Modify: `AGENTS.md` — document the `src/desktop/` vs `desktop/` split; fix two wrong paths.
- Version files each task: `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`.

---

### Task 1: Renderer strict-mode fixes + `tsconfig.desktop.json`

**Files:**
- Modify: `desktop/renderer/chatPane.tsx`
- Create: `desktop/renderer/vite-env.d.ts`
- Create: `tsconfig.desktop.json`
- Modify: `package.json` (add `typecheck:desktop` script only)
- Modify (version bump to `0.1.119`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm run typecheck:desktop` script and a green renderer typecheck that Tasks 2–3 rely on as a baseline.

**Background:** A 2026-09-13 probe (`tsc` with the config below over `desktop/renderer`, run from a scratch dir outside the repo) reported exactly 7 errors on current sources: `chatPane.tsx` 174/192 `TS2554` (`useRef<string>()` — the no-arg overload is gone from React 19 types), 210/282 `TS2322` (consequence of the same bad declarations: `.current = undefined` rejected), 315 `TS2345` (`role: event.type` widens to `string`), 526 `TS2345` (`scope` union `{} | { repoId }` lacks the required `repoId` key), and `src.tsx` `TS2882` (`style.css` has no declarations). The fixes below cleared the probe to exit 0. Runtime behavior is unchanged in each case (see step notes).

- [ ] **Step 1: Create `tsconfig.desktop.json` (red setup)**

Create `tsconfig.desktop.json` at repo root with exactamente this content:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["desktop/renderer"]
}
```

- [ ] **Step 2: Add the `typecheck:desktop` script**

In `package.json`, after the line `"build": "tsc -p tsconfig.json",` add:

```json
    "typecheck:desktop": "tsc -p tsconfig.desktop.json --noEmit",
```

- [ ] **Step 3: Run the typecheck to confirm red**

Run: `npm run typecheck:desktop`
Expected: FAIL with exactly these 7 errors — `chatPane.tsx` 174/192 `TS2554`, 210/282 `TS2322`, 315 `TS2345`, 526 `TS2345`, `src.tsx` `TS2882`. If the error set differs, stop and report; do not invent fixes.

- [ ] **Step 4: Fix the two `useRef` declarations (fixes 174, 192, 210, 282)**

In `desktop/renderer/chatPane.tsx`, replace:

```tsx
const adoptedRef = useRef<string>();
```

with:

```tsx
const adoptedRef = useRef<string | undefined>(undefined);
```

and replace:

```tsx
const seedReq = useRef<string>();
```

with:

```tsx
const seedReq = useRef<string | undefined>(undefined);
```

Note: passing `undefined` explicitly is runtime-identical to the old no-arg call (`current` starts `undefined` either way); this only satisfies the React 19 types, which require the initial-value argument. Errors 210 and 282 (`adoptedRef.current = undefined`, `seedReq.current = undefined`) clear as a consequence with no further edits.

- [ ] **Step 5: Narrow the `role` value (fixes 315)**

In `desktop/renderer/chatPane.tsx`, replace:

```tsx
setMessages(current => [...current, { id: event.id, role: event.type, text: event.text ?? "" }]);
```

with:

```tsx
setMessages(current => [...current, { id: event.id, role: event.type === "notice" ? "notice" : "error", text: event.text ?? "" }]);
```

Note: this line only runs when `event.type` is `"notice"` or `"error"` (the enclosing `else if` condition), so the ternary yields the same value with a narrow type. No cast is used, per repo type discipline.

- [ ] **Step 6: Always include `repoId` in `scope` (fixes 526)**

In `desktop/renderer/chatPane.tsx`, replace:

```tsx
  // Backend scope for this pane: multi-repo workspaces add repoId so the IPC
  // layer resolves the turn against one repo; single-repo panes send none and
  // keep the wire shape exactly as before.
  const scope = repoId === undefined ? {} : { repoId };
```

with:

```tsx
  // Backend scope for this pane: repoId is always present (undefined for
  // single-repo panes) so the object matches the ChatRequest bridge type.
  // JSON.stringify drops undefined values, so the wire shape is exactly as
  // before and the backend still resolves single-repo panes to their root.
  const scope = { repoId };
```

Note: every consumer of `scope` serializes through `JSON.stringify` (`chatSend`, `chatStatus`), which drops `undefined`-valued keys, so the bytes on the wire are unchanged.

- [ ] **Step 7: Add `vite-env.d.ts` (fixes `src.tsx` TS2882)**

Create `desktop/renderer/vite-env.d.ts` with exactly this one line:

```ts
/// <reference types="vite/client" />
```

This is the standard Vite scaffold file; it declares `*.css` side-effect imports. No other change to `src.tsx` is needed.

- [ ] **Step 8: Run the typecheck to confirm green**

Run: `npm run typecheck:desktop`
Expected: PASS (exit 0, no output).

- [ ] **Step 9: Run the existing test suite**

Run: `npm test`
Expected: all suites pass (the fixes touch only the React component body and prop shapes; the pure functions covered by `tests/desktop-chatPane.test.ts` and siblings are untouched).

- [ ] **Step 10: Bump version to `0.1.119` and commit**

Replace `0.1.118` with `0.1.119` in: `src/version.ts` (`VERSION`), `package.json` (`"version"`), `package-lock.json` (both `"version"` lines — top-level and `packages[""]`), `installer/cloudcode.iss` (`#define AppVersion`).

```bash
git add desktop/renderer/chatPane.tsx desktop/renderer/vite-env.d.ts tsconfig.desktop.json package.json src/version.ts package-lock.json installer/cloudcode.iss docs/superpowers/plans/2026-09-13-desktop-governance.md
git commit -m "feat(desktop): typecheck renderer via tsconfig.desktop.json, fix strict errors (0.1.119)"
```

---

### Task 2: Extend `lint` and `lint:size` to `desktop/`

**Files:**
- Modify: `package.json` (`lint` script)
- Modify: `scripts/check-file-size.mjs` (`ROOTS`, `EXTENSIONS`)
- Modify (version bump to `0.1.120`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: green `npm run typecheck:desktop` baseline from Task 1 (untouched by this task).
- Produces: `npm run lint` and `npm run lint:size` covering `desktop/`; two new soft warnings (`src.tsx`, `chatPane.tsx`) as accepted follow-up fodder, zero hard failures.

- [ ] **Step 1: Widen the `lint` script**

In `package.json`, replace:

```json
    "lint": "oxlint src tests",
```

with:

```json
    "lint": "oxlint src tests desktop",
```

Note: `node node_modules/oxlint/bin/oxlint desktop` was verified 2026-09-13 to exit 0 with zero warnings, so this step is expected to stay green.

- [ ] **Step 2: Widen the size check**

In `scripts/check-file-size.mjs`, replace:

```js
const ROOTS = ["src", "tests"];
const EXTENSIONS = [".ts", ".tsx", ".mjs"];
```

with:

```js
const ROOTS = ["src", "tests", "desktop"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".cjs"];
```

`.css` stays excluded (`style.css` is not code). `preload.cjs` (58 lines) is covered by the new `.cjs` extension.

- [ ] **Step 3: Run lint, expect green**

Run: `npm run lint`
Expected: PASS (exit 0).

- [ ] **Step 4: Run the size check, expect two new soft warnings**

Run: `npm run lint:size`
Expected: exit 0 with exactly these two warn lines and nothing else:

```text
warn  desktop/renderer/src.tsx is 691 lines, over the 600-line soft limit (see AGENTS.md)
warn  desktop/renderer/chatPane.tsx is 593 lines, over the 600-line soft limit (see AGENTS.md)
```

(The pre-change baseline is `All files under 600 lines.`.) Do NOT split either file — the warnings are the intended visibility; splitting is deferred follow-up work.

- [ ] **Step 5: Bump version to `0.1.120` and commit**

Replace `0.1.119` with `0.1.120` in the same four version files as Task 1 Step 10.

```bash
git add package.json scripts/check-file-size.mjs src/version.ts package-lock.json installer/cloudcode.iss
git commit -m "chore: extend lint and size ceiling to desktop/ (0.1.120)"
```

---

### Task 3: CI coverage + `AGENTS.md` documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`
- Modify (version bump to `0.1.121`): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`

**Interfaces:**
- Consumes: `typecheck:desktop` script (Task 1), `desktop:build` script (pre-existing: `npm run build && vite build --config desktop/vite.config.ts`).
- Produces: every-PR CI coverage for the renderer and an `AGENTS.md` that describes the split truthfully. Nothing else in the repo reads CI or `AGENTS.md` at runtime, so no downstream steps depend on this task.

- [ ] **Step 1: Add desktop steps to CI**

In `.github/workflows/ci.yml`, in the `build-and-test` job, after:

```yaml
      - name: Type-check and build
        run: npm run build
```

insert:

```yaml
      - name: Typecheck desktop renderer
        run: npm run typecheck:desktop

      - name: Build desktop app
        run: npm run desktop:build
```

Note: `desktop/dist/` is gitignored, so building in CI dirties nothing. `desktop:build` re-runs the main `tsc` build first, which also proves the two configs coexist.

- [ ] **Step 2: Document the split in `AGENTS.md`**

After the `src/ui/` bullet:

```md
- **`src/ui/`** — the hand-rolled terminal renderer: ANSI/terminal
  primitives (`term/`), widgets, themes, layout, markdown rendering. No
  provider/network calls belong here.
```

insert:

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

- [ ] **Step 3: Fix the two wrong backend paths in `AGENTS.md`**

Replace `` `desktop/guiBackend.ts` `` with `` `src/desktop/guiBackend.ts` `` (in the paragraph about the `--gui-server` extraction) and replace `` `desktop/guiCommandContext.ts` `` with `` `src/desktop/guiCommandContext.ts` `` (in the same paragraph, the `AppCommandDeps` sentence). Both old strings occur exactly once each.

- [ ] **Step 4: Run the full gate locally (mirrors CI order)**

Run, in order, each expecting PASS except `lint:size` per Task 2 Step 4:

```bash
npm run lint
npm run lint:size
npm run build
npm run typecheck:desktop
npm run desktop:build
npm test
```

Expected: `lint` clean; `lint:size` exit 0 with only the two accepted soft warns; `build`, `typecheck:desktop`, `desktop:build` exit 0; full test suite green (includes `tests/packaging.test.ts`, which re-pins the version agreement after the bump below — so run `npm test` again after Step 5 if the bump happens first; simplest order: bump, then run this gate, then commit).

- [ ] **Step 5: Bump version to `0.1.121` and commit**

Replace `0.1.120` with `0.1.121` in the same four version files. (Run the Step 4 gate after the bump so `packaging.test.ts` validates the final numbers.)

```bash
git add .github/workflows/ci.yml AGENTS.md src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "docs: document desktop split in AGENTS.md, check desktop in CI (0.1.121)"
```
