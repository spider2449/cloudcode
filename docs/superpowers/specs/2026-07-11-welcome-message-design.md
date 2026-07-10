# Startup Welcome Message — Design

Date: 2026-07-11

## Goal

Show a startup message when cloudcode launches. The message text lives in a plain
text file that the developer edits directly — no code changes needed to reword it.

## Design

- **File:** `welcome.txt` at the package root (next to `package.json`). Plain text,
  may span multiple lines.
- **Loading:** resolved relative to the compiled module via `import.meta.url`
  (walk up from `dist/` to the package root), read once at startup with
  `readFileSync`. No build-step changes needed since the file is not under `src/`.
- **Placeholders:** the loaded text supports `{version}`, `{provider}`, and
  `{model}`, replaced at display time. Unknown placeholders are left as-is.
- **Display:** the rendered text becomes the first `notice` item in the transcript
  (initial value of `items` in `App.tsx`), shown before the first prompt.
  `/clear` does not re-show it.
- **Error handling:** if `welcome.txt` is missing or unreadable, show no message
  (fail-safe, no error output).

## Components

- `src/ui/welcome.ts` — `loadWelcome(vars: {version, provider, model}): string | undefined`.
  Reads the file, substitutes placeholders, returns `undefined` on any failure.
- `src/ui/App.tsx` — seed `items` with the welcome notice when `loadWelcome` returns text.
- `welcome.txt` — the editable message content.

## Testing

Unit-test `loadWelcome`: placeholder substitution, missing file returns
`undefined`, multi-line content preserved. Verify manually that the message
appears on launch.
