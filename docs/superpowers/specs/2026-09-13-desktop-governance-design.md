# Design: desktop governance unification (no relocation)

Date: 2026-09-13. Approved approach A from the 2026-09-13 brainstorm:
bring `desktop/` under the same governance as `src/` without moving any
files. Physical relocation (options B/C) is deferred until the dual root
causes concrete day-to-day pain.

## Context

- `src/desktop/` (18 TS files: `guiBackend.ts`, `shellHost.ts`,
  `guiCommandContext.ts`, …) is the GUI backend. It compiles with the main
  `tsconfig.json` (`rootDir: src`), is covered by `tests/desktop-*.test.ts`,
  and is linted and size-checked.
- `desktop/` (`main.mjs`, `preload.cjs`, `renderer/` × 11, `vite.config.ts`)
  is the Electron shell plus the Vite+React renderer. It sits outside
  `tsconfig.json` (`include: ["src"]`), outside `npm run lint`
  (`oxlint src tests`), outside `lint:size` (`ROOTS = src, tests`), and
  outside CI's build steps. The renderer reaches into `src/` via
  `../../src/*.js` imports in 5 files.
- Pre-existing soft-limit breaches in the ungoverned area: `src.tsx`
  (691 lines), `chatPane.tsx` (593 lines) vs the 600-line ceiling.
- `AGENTS.md` "Where things go" does not mention desktop at all and
  misstates the backend path as `desktop/guiBackend.ts` (actual:
  `src/desktop/guiBackend.ts`).

## Non-goals

- No file moves or import-path changes (options B/C explicitly deferred).
- No splitting of `src.tsx` / `chatPane.tsx`; they surface as soft warnings
  only, split later as follow-up work.
- No `checkJs` for `main.mjs` / `preload.cjs`; oxlint coverage is enough.

## Changes

### 1. Typecheck: new `tsconfig.desktop.json`, main config untouched
- Add `tsconfig.desktop.json`: `jsx: react-jsx`,
  `lib: ["ES2022", "DOM", "DOM.Iterable"]`,
  `moduleResolution: Bundler`, `strict: true`, `noEmit: true`,
  `skipLibCheck: true`, `include: ["desktop/renderer"]`.
- The main `tsconfig.json` stays unchanged: widening its `include` /
  changing `rootDir` would alter the `dist/` output layout.
- Add script `typecheck:desktop": "tsc -p tsconfig.desktop.json --noEmit"`.
- `src/` files pulled in via the renderer's `../../src/*.js` imports are
  typechecked as part of the program; nothing is emitted.

### 2. Lint: oxlint covers `desktop/`
- `"lint": "oxlint src tests desktop"`. Verified 2026-09-13:
  `oxlint desktop` exits 0 with zero warnings, so this is additive.

### 3. Size ceiling: `lint:size` covers `desktop/`
- `scripts/check-file-size.mjs`: `ROOTS` gains `"desktop"`,
  `EXTENSIONS` gains `".cjs"` (for `preload.cjs`). `.css` stays excluded.
- Expected effect: `src.tsx` and `chatPane.tsx` appear as soft warnings,
  zero hard failures. No splits in this change.

### 4. CI: desktop checked on every PR
- `build-and-test` job gains `npm run typecheck:desktop` and
  `npm run desktop:build` (tsc + vite, validates the cross-root imports
  bundle). `desktop/dist/` is gitignored, so CI builds dirty nothing.

### 5. AGENTS.md: document desktop, fix wrong path
- "Where things go" gains: `src/desktop/` = GUI backend (TS, compiled into
  `dist/`, the logic behind `--gui-server`); `desktop/` = Electron shell
  (`main.mjs`, `preload.cjs`) + Vite renderer (`desktop/renderer/`,
  DOM+React, checked by `tsconfig.desktop.json`).
- Fix `desktop/guiBackend.ts` → `src/desktop/guiBackend.ts`.

### 6. Version + tests
- Patch bump in the same commit per AGENTS.md versioning rule
  (`src/version.ts`, `package.json` + `package-lock.json` × 2,
  `installer/cloudcode.iss`); `tests/packaging.test.ts` pins the agreement.
- No new test files: no behavior changes. Full gate:
  `npm run lint`, `npm run lint:size` (2 new soft warns, 0 hard),
  `npm run build`, `npm run typecheck:desktop`, `npm run desktop:build`,
  `npm test`.
