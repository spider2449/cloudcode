# Desktop Packaging Design

Date: 2026-09-04
Status: Approved design, pending implementation plan
Scope: `npm run desktop:package` for the Electron GUI on Win/Linux/macOS, bundling the CLI. CLI packaging unchanged.

## 1. Goal

Ship a self-contained CloudCode Desktop app alongside the existing CLI artifacts. One command builds the renderer, the compiled CLI, native modules, and OS installers. No second conversation controller; the GUI keeps spawning the bundled TUI over a PTY.

## 2. Architecture

- Builder: `electron-builder` (new devDependency). Targets: NSIS x64 (Windows), AppImage + deb (Linux), DMG arm64 + x64 (macOS).
- Electron main entry stays `desktop/main.mjs`; preload stays `desktop/preload.cjs`.
- Bundled files: `dist/**` (compiled CLI including `dist/cli.js` and `dist/desktop/shellHost.js`), `desktop/dist/**` (Vite renderer), `desktop/preload.cjs`, `package.json`. No source `.ts`, no `desktop/dist` committed to git.
- `node-pty` rebuilt per target OS via `electron-builder install-app-deps` before packaging.
- Asar enabled. `main.mjs` PTY spawn path resolves `dist/cli.js` relative to packaged resources (adjust `projectRoot` for `app.asar` layout, fall back to dev layout when running `electron .`).
- Existing `cloudcode` terminal flow, engine, and permission semantics unchanged.

## 3. Scripts

- `scripts/desktop-package.mjs`: orchestrates `tsc -p tsconfig.json`, `vite build --config desktop/vite.config.ts`, `electron-builder install-app-deps`, then `electron-builder --win/--linux/--mac` per CLI flag. Fails fast with an actionable message when `dist/` or `desktop/dist/` is missing.
- `package.json` scripts:
  - `desktop:dist` — build only (tsc + vite), no installer.
  - `desktop:package` — full build + installer for the current OS (flags forwarded to the script).
  - `package:all` — existing CLI `package` plus `desktop:package`.
- Inline `build` config in `package.json` (appId `app.cloudcode`, productName `CloudCode`, artifact names including version). No separate `electron-builder.yml`.

## 4. Versioning

Extend the existing four-file sync (`src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`) to the builder `build.appId`/version source, which reads `package.json` version. `tests/packaging.test.ts` asserts the builder file list and version agreement.

## 5. CI

New `release-smoke-test.yml` leg per OS runs `desktop:package` and asserts the installer artifact exists (`release/*.exe`, `*.AppImage`/`*.deb`, `*.dmg`). Existing CLI legs unchanged.

## 6. Error handling

- Missing build output aborts before builder with `Run npm run desktop:dist first`-style message and nonzero exit.
- IPC/PTY behavior unchanged; no new renderer-exposed errors.

## 7. Testing

- Extend `tests/packaging.test.ts`: builder config present, file patterns cover `dist/**` + `desktop/dist/**` + preload, version agreement holds.
- Manual smoke per OS: install, open project, resume session, stream reply, close window with no orphan PTY.

## Non-goals

- Auto-update, code signing/notarization, separate `electron-builder.yml`, replacing the CLI installer, or a second GUI conversation controller.
