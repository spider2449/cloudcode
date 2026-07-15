# Memory System Research Notes

Research for adding `/memory` to cloudcode.
Date: 2026-07-15.

## Overview — two distinct memory systems

The reference has TWO separate things both called "memory":

1. **CLAUDE.md memory files** — the classic instruction files (`~/.claude/CLAUDE.md`,
   `./CLAUDE.md`, `@`-imports, nested dirs). The `/memory` command edits these.
2. **Auto-memory (memdir)** — an agent-managed directory of typed memory files with a
   `MEMORY.md` index, injected into the system prompt, plus background extraction
   ("extractMemories") and nightly consolidation ("autoDream" / `/dream`).

## 1. The /memory command itself

Files:
- `src/commands/memory/index.ts` — command definition: `{ type: 'local-jsx', name: 'memory', description: 'Edit Claude memory files', load: () => import('./memory.js') }` (lazy-loaded).
- `src/commands/memory/memory.tsx` — the dialog component.

Behavior of `/memory`:
1. Before rendering: `clearMemoryFileCaches()` then `await getMemoryFiles()` to prime the cache (avoids Suspense fallback flash).
2. Shows a `Dialog` titled "Memory" containing a `MemoryFileSelector` list.
3. On select:
   - `mkdir -p` the config home dir if the path is under it.
   - Create the file empty with `writeFile(path, '', { flag: 'wx' })`, catching `EEXIST` to preserve existing content.
   - Open it in the user's editor via `editFileInEditor(path)`.
   - Report which editor was used, based on `$VISUAL` → `$EDITOR` → default, with a hint on how to change it.
4. On cancel: "Cancelled memory editing" (display: 'system').
5. Footer link to https://code.claude.com/docs/en/memory

## 2. MemoryFileSelector (src/components/memory/MemoryFileSelector.tsx)

Builds the selectable list:
- Existing memory files from `getMemoryFiles()` (utils/claudemd.ts), which returns
  `MemoryFileInfo[]` including `@`-imported files (`parent` field) and nested/dynamically
  loaded CLAUDE.md files.
- Always offers **User memory** (`~/.claude/CLAUDE.md`) and **Project memory**
  (`./CLAUDE.md`) even if they don't exist yet — marked "(new)".
- Labels: "User memory" / "Project memory"; imported files shown indented with
  `L path (new)` tree style; descriptions: "Saved in ~/.claude/CLAUDE.md",
  "Checked in at ./CLAUDE.md" (or "Saved in" when not a git repo), "@-imported",
  "dynamically loaded".
- Remembers last selected path (module-level `lastSelectedPath`).
- If auto-memory is enabled, appends folder-open entries (prefix `__open_folder__`):
  "Open auto-memory folder", "Open team memory folder" (feature TEAMMEM), and
  per-agent memory folders ("Open <agent> agent memory").
- Also renders toggles in the dialog: **auto-memory on/off** and **auto-dream on/off**
  (writes `autoMemoryEnabled` / `autoDreamEnabled` to userSettings), and shows dream
  status ("running" / "last ran X ago" / "never").

## 3. Memory file discovery (src/utils/claudemd.ts, ~1500 lines)

- `MemoryFileInfo { path, type: 'User'|'Project'|..., content, parent?, isNested? }`
- `getMemoryFiles()` — memoized async; collects user CLAUDE.md, project CLAUDE.md,
  @-imports (recursive, includes-first ordering), nested-directory CLAUDE.md files.
- `clearMemoryFileCaches()` / `resetGetMemoryFilesCache` — cache invalidation (compaction
  also resets it).
- Helpers: `getLargeMemoryFiles()`, `getMemoryFilesForNestedDirectory()`, conditional
  rules matching ("paths"-scoped CLAUDE.md rules).

## 4. Auto-memory directory layout & paths (src/memdir/paths.ts)

- Base: `~/.claude` (or `CLAUDE_CODE_REMOTE_MEMORY_DIR`).
- Auto-memory dir: `<base>/projects/<sanitized-canonical-git-root>/memory/` —
  uses **canonical git root** so all worktrees of one repo share one memory dir.
- Entrypoint: `MEMORY.md` inside that dir.
- Daily logs (assistant/KAIROS mode): `<dir>/logs/YYYY/MM/YYYY-MM-DD.md`.
- Overrides: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env (no ~ expansion), or
  `autoMemoryDirectory` in settings (~ expansion; **projectSettings intentionally
  excluded** — a malicious repo could point memory at `~/.ssh` and gain a write
  carve-out). Path validation rejects relative, root/drive-root, UNC, null bytes.
- Enable gate `isAutoMemoryEnabled()` priority: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env →
  `CLAUDE_CODE_SIMPLE` (--bare) off → remote-without-memory-dir off →
  `autoMemoryEnabled` setting → default ON.
- `isAutoMemPath()` gives writes inside the memory dir a permission carve-out.

## 5. Memory prompt injection (src/memdir/memdir.ts)

- `loadMemoryPrompt()` builds a "# auto memory" system-prompt section; returns null if
  disabled. Ensures the dir exists first (`ensureMemoryDirExists`) so the model never
  wastes turns on mkdir — prompt explicitly says "This directory already exists…".
- `MEMORY.md` caps: **200 lines / 25 KB** (`truncateEntrypointContent`), line-truncate
  first then byte-truncate at last newline, appends a WARNING naming which cap fired.
- Two-step save protocol taught in the prompt: (1) write each memory to its own file
  with frontmatter; (2) add a one-line pointer (`- [Title](file.md) — hook`, <150 chars)
  to MEMORY.md. MEMORY.md is an index, never content. (A `skipIndex` feature-flag
  variant drops step 2 entirely.)
- Also includes: "Memory vs plans vs tasks" guidance, and a "Searching past context"
  section (grep memory `*.md`, then session transcripts `*.jsonl` as last resort).
- KAIROS (assistant) mode: append-only daily logs instead of editing MEMORY.md;
  a nightly /dream distills logs into topic files + MEMORY.md.

## 6. Memory taxonomy (src/memdir/memoryTypes.ts)

Closed set of 4 types: `user`, `feedback`, `project`, `reference`.
- Frontmatter format: `name`, `description` (used for relevance selection), `type`.
- feedback/project bodies: rule/fact first, then `**Why:**` and `**How to apply:**`.
- "What NOT to save": anything derivable from repo state (code patterns, git history,
  fix recipes, CLAUDE.md content, ephemeral task state) — applies **even when the user
  explicitly asks to save** (ask what was surprising/non-obvious instead; eval-validated).
- Recall-side guidance (eval-validated wording, positions matter):
  - "When to access memories" incl. explicit-ignore handling (treat MEMORY.md as empty).
  - Drift caveat: verify memory against current state; update/remove stale memories.
  - "Before recommending from memory": if a memory names a file/function/flag, check it
    still exists before recommending.
- Combined (team) variant adds per-type `<scope>` (private/team) guidance.

## 7. Query-time recall (src/memdir/findRelevantMemories.ts + memoryScan.ts)

- `scanMemoryFiles(dir)`: recursive readdir for `*.md` (excluding MEMORY.md), read first
  30 lines for frontmatter, sort newest-first, cap 200 files.
- `formatMemoryManifest()`: `- [type] filename (ISO mtime): description` lines.
- `findRelevantMemories(query, dir)`: sends the query + manifest to a **Sonnet side
  query** (max_tokens 256, JSON schema output `{selected_memories: string[]}`) which
  picks up to 5 clearly-relevant files. Filters out already-surfaced paths and
  reference-docs for tools currently in use (but keeps gotcha/warning memories about
  them). Selected files are attached to context with mtime for freshness display.

## 8. Background extraction (src/services/extractMemories/)

- Runs at end of each complete query loop (stop hooks) as a **forked agent** sharing the
  parent's prompt cache (`runForkedAgent` + `createCacheSafeParams`).
- Skips if the main agent already wrote to the memory dir this turn
  (`hasMemoryWritesSince`) — main agent and background extractor are mutually exclusive
  per turn.
- Extraction prompt: analyze last ~N messages only; tool allowlist (Read/Grep/Glob,
  read-only Bash, Write/Edit restricted to the memory dir; no rm, no MCP/Agent);
  turn-budget strategy: parallel reads turn 1, parallel writes turn 2; existing-memory
  manifest pre-injected so it doesn't waste a turn on ls; "do not verify against source".
- Gated by GrowthBook flags (`isExtractModeActive`).

## 9. Consolidation "dream" (src/services/autoDream/)

- Nightly-ish background consolidation: fires the /dream prompt as a forked subagent.
- Gates (cheapest first): time (≥ minHours since lastConsolidatedAt, default 24h) →
  sessions (≥ minSessions transcripts touched since, default 5) → file lock
  (consolidationLock.ts, with rollback). Scan throttle 10 min.
- Config: `autoDreamEnabled` setting; thresholds from a feature flag.
- UI shows dream status in the /memory dialog (running / last ran / never).

## 10. UI niceties

- `MemoryUpdateNotification.tsx` — notification when memories are updated;
  `getRelativeMemoryPath()` for display (`~/.claude/...` style).
- `createMemorySavedMessage` — system message shown when background agents save memory.
- Analytics events: `tengu_memdir_loaded`, `tengu_auto_memory_toggled`,
  `tengu_auto_dream_toggled`, `tengu_memdir_disabled`, memory-shape telemetry.
- `/remember` is referenced in comments (explicit save flow) alongside /dream.

## Suggested scope tiers for cloudcode

- **Tier 1 (the `/memory` command)**: file selector (User/Project CLAUDE.md + offer
  "(new)"), create-if-missing with `wx` flag, open in $VISUAL/$EDITOR, cache
  clear/reload after edit. Small and self-contained.
- **Tier 2**: auto-memory dir per project keyed on git root, MEMORY.md index with
  200-line/25KB truncation, four-type frontmatter taxonomy, system-prompt injection,
  write carve-out for the memory dir.
- **Tier 3**: query-time recall via small-model side query over a frontmatter manifest;
  turn-end forked extraction agent; consolidation with time/session/lock gates.

Key design decisions worth copying regardless of tier:
- MEMORY.md is an index, not content (hard caps + truncation warning).
- Harness pre-creates the memory dir and tells the model so (saves turns).
- Never trust project-committed settings for the memory path (security).
- Explicit-save exclusions ("even when the user asks") and recall-drift verification
  wording are eval-validated — copy the wording, not just the idea.
