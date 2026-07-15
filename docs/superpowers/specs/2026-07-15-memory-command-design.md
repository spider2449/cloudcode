# /memory Command + Auto-Memory System — Design

Date: 2026-07-15
Research source: `docs/research/memory-system-reference.md`

## Goal

Give cloudcode a persistent memory system: a `/memory` command to edit memory
files, an agent-managed auto-memory directory injected into the system prompt,
and a background extraction agent that saves memories the main agent missed.

Out of scope (deferred): query-time side-query recall, "dream" consolidation,
team memory, git-root canonicalization for the memory key.

## 1. Storage layout

- Auto-memory directory: `<configDir>/projects/<sanitized-cwd>/memory/`
  - `sanitized-cwd`: the absolute project path with path separators, colons,
    and other unsafe characters replaced by `-` (same character class as the
    reference's `sanitizePath`).
  - `configDir()` comes from `src/agent/providers.ts` (already used by
    settings).
- `MEMORY.md` inside that directory is the index: one line per memory,
  `- [Title](file.md) — one-line hook`, no frontmatter, never content.
- Each memory is its own `.md` file with frontmatter:

  ```markdown
  ---
  name: short-kebab-slug
  description: one-line summary used for relevance decisions
  type: user | feedback | project | reference
  ---

  body (feedback/project: rule/fact first, then **Why:** and **How to apply:**)
  ```

- The harness creates the directory (recursive mkdir, EEXIST-safe) at session
  start when auto-memory is enabled, so prompts can truthfully say "this
  directory already exists — write to it directly".

## 2. System-prompt injection (`src/engine/systemPrompt.ts`)

New module `src/engine/memoryPrompt.ts` exporting:

- `truncateEntrypoint(raw): { content, wasTruncated }` — caps MEMORY.md at
  200 lines AND 25 000 bytes (line-truncate first, then byte-truncate at the
  last newline), appending a warning that names which cap fired.
- `buildMemoryPrompt(memoryDir): string` — ports the reference's
  `buildMemoryLines`: intro ("persistent file-based memory at <dir>",
  dir-exists guidance), four-type taxonomy section, "What NOT to save"
  (including the explicit-save gate: exclusions apply even when the user asks
  to save), two-step save protocol, "When to access memories" (including the
  ignore-memory and drift-verification bullets), "Before recommending from
  memory" section, then the truncated `MEMORY.md` content (or an "empty"
  note).

`systemPrompt.ts` changes:

- Load user-level `<configDir>/CLAUDE.md` as a
  `# User instructions (CLAUDE.md)` section before the existing project
  CLAUDE.md section (fixes the current gap where user CLAUDE.md is ignored).
- Append the memory section when `autoMemoryEnabled` is on.

## 3. Background extractor (`src/engine/extractMemories.ts`)

- Trigger: end of each completed turn (final assistant response with no
  pending tool calls), fire-and-forget so it never blocks the UI.
- Skip conditions:
  - auto-memory disabled;
  - fewer than a minimum number of new model-visible messages since the last
    extraction (cursor tracked per session);
  - the main agent already performed a Write/Edit targeting a path inside the
    memory directory since the cursor (main agent and extractor are mutually
    exclusive per turn).
- Input: recent messages since the cursor, plus a pre-scanned manifest of
  existing memory files (`- [type] filename (mtime): description`, newest
  first, capped at 200 files, frontmatter read from the first 30 lines only).
- Prompt: ported from the reference's `buildExtractAutoOnlyPrompt` — analyze
  only the recent messages, do not investigate the repo, update existing
  files rather than duplicating, two-step save protocol.
- Execution: one side conversation on the current provider/model with a small
  tool set (read file, write file, edit file). Writes/edits are validated to
  resolve inside the memory directory; anything else is rejected. No shell.
  Bounded turn budget (e.g. 4 turns).
- On completion with writes: surface a dim notice in the UI ("memory updated")
  and advance the cursor. On failure: log, advance cursor anyway (never retry
  the same range).

## 4. `/memory` command (`src/commands/builtins.ts` + picker)

- `/memory` opens a picker (reusing the existing picker UI pattern used by
  resume/project pickers) with:
  - `User memory` — `<configDir>/CLAUDE.md` (marked "(new)" if missing)
  - `Project memory` — `./CLAUDE.md` (marked "(new)" if missing)
  - `Open auto-memory folder` — the auto-memory directory
- On selecting a file: create it empty with the `wx` flag (EEXIST preserved),
  then open in `$VISUAL` → `$EDITOR` → platform fallback (`notepad` on
  Windows, `nano` otherwise), suspending/restoring the TUI around the editor.
  Afterward, rebuild the system prompt so edits take effect immediately and
  show a notice naming the file and which env var chose the editor.
- On selecting the folder: open with the platform file manager
  (`explorer` / `open` / `xdg-open`).

New `CommandContext` needs: nothing if the picker is driven the same way as
`openResumePicker()`; add `openMemoryPicker(): void` plus a
`refreshSystemPrompt(): Promise<void>` (or equivalent) hook.

## 5. Settings

- `autoMemoryEnabled?: boolean` added to `Settings` (default: true when
  absent). Settable via `/config autoMemoryEnabled true|false` (extend
  CONFIG_KEYS) — controls prompt injection, dir creation, and the extractor.

## 6. Error handling

- Memory dir creation failure: log, continue without memory section.
- Editor launch failure: notice with the error; file still created.
- Extractor failures are silent to the user beyond a debug log.
- Path validation on extractor writes prevents escapes via `..` (resolve then
  prefix-check against the memory dir).

## 7. Testing

Vitest units:

- path sanitization → stable, collision-safe directory names on Windows paths;
- `truncateEntrypoint` line/byte cap behavior and warning text;
- extractor skip logic (message-count cursor, memory-write detection);
- write-path validation (inside/outside dir, `..` traversal);
- picker option building (existing/missing files, "(new)" labels);
- systemPrompt composition with/without user CLAUDE.md and MEMORY.md.
