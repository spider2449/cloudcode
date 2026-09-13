# Design: consolidate desktop into src/desktop (single physical home)

Date: 2026-09-13. Goal: exactly one `desktop` in the repo. The split
(`src/desktop/` backend vs root `desktop/` shell+renderer) was unified
under governance in the 2026-09-13 governance change; this design removes
the split physically.

## Frozen constraints

- `dist/` output layout is byte-identical: `dist/cli.js`,
  `dist/desktop/*` unchanged. Anything Electron, the installer, or the
  release smoke test resolves keeps working untouched.
- Release pipeline (`desktop:build`, `desktop-package.mjs`,
  electron-builder, smoke test globs over `release/desktop/*`) keeps
  working; only path strings inside it change.
- No behavior changes, no dependency changes, no `src/core`-style
  regrouping of TUI code (explicitly rejected: it would move `dist/`
  output and touch every import for zero new information).

## Target layout

```text
src/desktop/
├── <18 backend files, untouched>  # guiBackend.ts, shellHost.ts, …
├── renderer/                      # moved from desktop/renderer (15 files)
├── shell/                         # main.mjs + preload.cjs from desktop/
└── vite.config.ts                 # moved from desktop/vite.config.ts
```

Root `desktop/` is deleted (including the gitignored build output; the
new gitignored output is `dist/renderer/` — amended 2026-09-13, see
"Build and packaging wiring"). Backend files stay flat
in `src/desktop/` — no new `backend/` directory — so their import depth,
`cli.tsx`'s `./desktop/*` imports, backend test paths, and tsc output
all hold without edits.

## Moves and import rewrites (mechanical, no logic changes)

- `desktop/renderer/*` → `src/desktop/renderer/*` (15 files): `../../src/X.js`
  becomes `../../X.js` (6 imports: version, statusPayload,
  builtinThemes ×2, guiSlashNames, appMenu, statusLineItems). `./`
  sibling imports, `index.html`, `style.css` untouched.
- `desktop/main.mjs` → `src/desktop/shell/main.mjs`:
  `../dist/desktop/*.js` becomes `../../../dist/desktop/*.js`;
  dev `projectRoot` becomes `join(desktopDir, "..", "..", "..")`;
  dev `resolveCliPath` candidates gain the same two levels. Packaged
  (`.asar`) branch logic untouched — guaranteed by frozen `dist/`.
  Preload sibling reference untouched.
- `desktop/preload.cjs` → `src/desktop/shell/preload.cjs`: untouched
  (no relative paths).
- `desktop/vite.config.ts` → `src/desktop/vite.config.ts`:
  `root: "desktop/renderer"` becomes `"src/desktop/renderer"`;
  `outDir` becomes `"../../../dist/renderer"` (amended 2026-09-13;
  originally `"../dist"` landing at `src/desktop/dist/`).

## Build and packaging wiring

- Vite output: `dist/renderer/` (gitignored; `dist/` was already fully
  ignored, so no gitignore entry is needed). All build output now lives
  under root `dist/`; `loadFile` becomes
  `join(desktopDir, "..", "..", "..", "dist", "renderer", "index.html")`,
  which resolves correctly in both dev and packaged (`.asar`) layouts
  since `dist/**` is bundled either way. Amended 2026-09-13: the
  original `src/desktop/dist/` placement put build output inside `src/`
  and was moved out on review. The `src/desktop/dist/` sibling-mirror
  alternative is rejected for that reason.
- `package.json`: `main` → `src/desktop/shell/main.mjs`;
  `desktop:build` vite config path updated; `desktop:start` electron
  entry updated; `build.files` entries `desktop/dist/**`,
  `desktop/preload.cjs`, `desktop/main.mjs` → `src/desktop/...`
  equivalents. `directories.output release/desktop` unchanged, so
  smoke-test globs are untouched.
- `scripts/desktop-package.mjs`: vite config path plus the
  `desktop/dist/index.html` existence check and message → new path.
- `.gitignore`: `desktop/dist/` entry removed (`dist/` was already
  ignored wholesale).
- `tsconfig.desktop.json`: `include` → `["src/desktop/renderer"]`,
  nothing else. Main `tsconfig.json` gains an `exclude` for
  `src/desktop/renderer`, `src/desktop/vite.config.ts` (and the
  then-planned `src/desktop/dist`) — without it the main `tsc` build
  chokes on the moved `.tsx` (no `--jsx`) and emits stray files into
  `dist/`; discovered during implementation, not in the original design.
- `scripts/check-file-size.mjs`: `ROOTS` drops `"desktop"`
  (renderer stays covered under `src`).
- CI: no changes (it only invokes npm scripts).

## Test updates (file names unchanged)

- `tests/desktop-*.test.ts` module imports: `../desktop/renderer/*.js`
  → `../src/desktop/renderer/*.js`. Backend test imports
  (`../src/desktop/*.js`) untouched.
- `readFileSync("desktop/renderer/...")`,
  `readFileSync("desktop/main.mjs")`,
  `readFileSync("desktop/preload.cjs")` strings → new paths
  (~40 sites; the `chatParity` filename-pinned assertions must pass
  in equal count after the move).
- `tests/packaging.test.ts` (living contract, updated deliberately):
  the `["dist/**", "desktop/dist/**", "desktop/preload.cjs"]` pattern
  list, the `desktop-package.mjs` contains-`"desktop/dist"`
  assertion, and the `files`-array assertion → new paths.
- Test file names keep the `desktop-` prefix (it names the theme,
  not the path).
- Historical files under `docs/superpowers/specs|plans/` are frozen
  and keep old paths; only `AGENTS.md` is rewritten.

## Docs

- `AGENTS.md` "Where things go": replace the two desktop bullets
  with a single `src/desktop/` entry describing its three areas
  (flat backend, `renderer/`, `shell/`) plus the unchanged cross-root
  import rule (renderer may only touch leaf modules of `src/`).
  Fix any leftover root-`desktop/` path strings in the lint/size
  and testing sections.

## Verification gate (all green before any commit lands)

1. `npm run build`, `npm run typecheck:desktop`,
   `npm run desktop:build` (vite emits `dist/renderer/index.html`),
   `npm run lint`, `npm run lint:size` (zero warnings), `npm test`.
2. `node --check` on both shell JS files.
3. Repo-root `desktop/` fully gone (`git status` shows renames only,
   no stragglers).
4. `dist/` filename set `diff`ed against pre-move build: identical
   (proves the output freeze).
5. Patch version bumped in all four places per the versioning rule.

## Non-goals

- No `src/core` regrouping. No backend logic changes. No new
  dependencies, no tsconfig restructuring, no test-file renames,
  no history-docs rewrite.
