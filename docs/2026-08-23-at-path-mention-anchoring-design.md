# @path mention anchoring design

Date: 2026-08-23

## Background

The UI side of `@` completion already exists (2026-07-10 autocomplete design):
an `@token` before the cursor offers a fuzzy file menu and accepting replaces
it with `@<path>`. The submission side was never built — the raw text reaches
the model with no convention explaining what `@` means, no existence
validation, and no anchoring.

## Goal

Anchor `@path` tokens at submission using **path anchoring only**: keep the
text as-is, teach the model the convention via the system prompt, and warn on
nonexistent paths. No content embedding (context cost, explicitly rejected).

## Components

### 1. `src/commands/mentions.ts` (new, commands layer)

```ts
export function extractMentions(text: string): string[];
// Same token grammar as completion.ts fileSuggestions:
// /(^|\s)@([\w./-]+)/g; returns deduplicated path strings without "@".
export function missingMentions(text: string, cwd: string): string[];
// Mentions where existsSync(resolve(cwd, path)) is false.
```

Edge rules: `@` must be line-start or whitespace-prefixed (emails like
`a@b.com` never match); directory paths count as existing (`existsSync` true
for dirs); Windows case-insensitivity comes free from the filesystem.

### 2. `engine/systemPrompt.ts`

Append one line to `buildSystemPrompt()`:

```text
User messages may contain @path tokens referencing project-relative files. Read them with the Read tool before acting on claims about their contents.
```

Applies to interactive and print mode alike (the system prompt is global).

### 3. `ui/nativeApp.ts` — sendUserMessage

Before appending the user item: run `missingMentions(text, props.cwd)`; for
each miss emit `notice("Note: <path> does not exist (yet)")`. Submission flow
unchanged — warnings never block sending, because a nonexistent @path may be
a new file the user wants created.

## Deliberately out of scope

Content inlining of any size; print-mode interactive warnings (print mode
still benefits from the system prompt line); syntax-aware detection of `@`
inside quotes/code spans; rendering/highlighting of mentions.

## Testing

- `tests/mentions.test.ts`: extraction (line-start/whitespace prefix, email
  non-match, dedup), missingMentions (existing file, missing file, directory).
- `tests/engine-system-prompt.test.ts`: prompt contains the convention line.
- `tests/app.test.ts`: submitting text with a nonexistent @path calls notice
  and still sends (mocked session.send).
