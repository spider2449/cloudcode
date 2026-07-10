# Command Autocompletion Design

Date: 2026-07-10
Status: Approved

## Goal

Replace the current minimal slash-command hint line with a real autocomplete system:
a selectable suggestion menu under the input box that completes slash-command
names, command arguments, and `@file` paths.

## Non-goals

- Skills and MCP commands (separate future features; they will plug into this
  system via the same registry/provider interfaces).
- Shell-style longest-common-prefix or cycling completion.
- Respecting full `.gitignore` semantics for file completion (simple ignore list
  for now).

## Architecture

A pure completion engine with pluggable providers, consumed by `InputBox` and
rendered by a new `SuggestionMenu` component.

### 1. Completion engine — `src/commands/completion.ts`

```ts
interface Suggestion {
  value: string;        // text inserted on accept
  label: string;        // shown in the menu (e.g. "/permissions", "src/cli.tsx")
  description?: string; // gray right-hand text
  replaceStart: number; // range in the input replaced by `value`
  replaceEnd: number;
}

function getSuggestions(
  text: string,
  cursor: number,
  ctx: CompletionContext
): Suggestion[];
```

`CompletionContext` carries the command registry, provider names, and a file
lister. Providers are checked in priority order; the first that matches the
cursor position wins:

1. **@file provider** — an `@token` immediately before the cursor (regex on the
   text left of the cursor). Suggests project file paths fuzzy-filtered by the
   token. Accepting replaces the `@token` with `@<path>`.
2. **Argument provider** — the input starts with `/<knownCommand> ` and the
   cursor is in the argument region. Delegates to the command's optional
   `completeArgs(prefix, ctx)`.
3. **Command-name provider** — the input matches `^/(\w*)` with the cursor at
   or after the prefix. Suggests command names with descriptions. Accepting
   inserts `/<name> ` (trailing space).

If no provider matches, the result is empty and no menu shows.

### 2. Argument completion — `src/commands/types.ts` + `builtins.ts`

`Command` gains an optional method:

```ts
completeArgs?(prefix: string, ctx: CommandContext): string[];
```

Implemented for:
- `/permissions` → `default`, `acceptEdits`, `bypassPermissions`, `list`, `clear`
- `/provider` → `ctx.providerNames()`

Other commands omit it (no argument suggestions).

### 3. File listing — `src/commands/fileIndex.ts`

- Recursively walks the project working directory.
- Skips: `node_modules`, `.git`, `dist`, dotfiles/dot-directories.
- Caps the walk at 5,000 entries as a safety valve.
- Caches the list; the cache is refreshed lazily when a new @-completion
  session starts (first `@` keystroke), not on every keypress.
- Fuzzy filter: subsequence match (all token chars appear in order in the
  path), ranked by (a) basename prefix match, (b) path shortness. Cap results
  at 10.

### 4. Menu interaction — `InputBox`

Menu state lives in `InputBox`: `suggestions: Suggestion[]`, `selected: number`,
recomputed on every input change (open = suggestions.length > 0 && !disabled).

Key handling while the menu is open:
- **Up/Down** — move the highlight (wraps). History recall is suppressed.
- **Tab / Enter** — accept the highlighted suggestion: replace
  `[replaceStart, replaceEnd)` with `value`, move the cursor after it, close
  the menu (it may immediately reopen if the new text matches a provider,
  e.g. argument suggestions after completing a command name). Enter does NOT
  submit while the menu is open.
- **Esc** — close the menu (sets a suppress flag cleared on the next text
  change); input is untouched. Esc-to-interrupt is unaffected (only applies
  while disabled).
- Any other key — normal editing; suggestions refilter live.

### 5. Rendering — `src/ui/SuggestionMenu.tsx`

Ink component below the input box:

```
> /pe█
  ▶ /permissions  Permission mode or rules
    /provider     Switch LLM provider
```

- `▶` marks the highlighted row; labels left-aligned, descriptions gray.
- Max 8 visible rows; the window scrolls to keep the highlight visible.
- Replaces the current gray hint line entirely.

## Error handling

- File walk errors (permission denied, broken symlinks) are silently skipped.
- An empty project or unreadable cwd yields no @ suggestions (no crash, no
  message).
- Engine is pure and total: any input/cursor combination returns an array.

## Testing

Vitest unit tests:
- `completion.test.ts` — provider selection by cursor position, replace
  ranges, command-name prefix matching, argument completion for
  `/permissions` and `/provider`, `@` at start/middle of text, `@` with no
  matches, empty input.
- `fileIndex.test.ts` — ignore list, fuzzy ranking, result cap (against a
  temp directory fixture).
- Existing InputBox behaviors (history recall, line continuation, paste
  chunking) must keep passing; menu-open key routing is covered by
  engine-level tests plus manual verification in the TUI.

## Future hooks

- `/skills` and `/mcp` commands will appear in the menu automatically once
  registered; skill/MCP argument completion plugs in via `completeArgs`.
