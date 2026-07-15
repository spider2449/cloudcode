export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export function truncateEntrypoint(raw: string): { content: string; wasTruncated: boolean } {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const overLines = lines.length > MAX_ENTRYPOINT_LINES;
  const overBytes = trimmed.length > MAX_ENTRYPOINT_BYTES;
  if (!overLines && !overBytes) return { content: trimmed, wasTruncated: false };
  let out = overLines ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (out.length > MAX_ENTRYPOINT_BYTES) {
    const cut = out.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    out = out.slice(0, cut > 0 ? cut : MAX_ENTRYPOINT_BYTES);
  }
  const reason = overLines && overBytes
    ? `${lines.length} lines and ${trimmed.length} bytes`
    : overLines
      ? `${lines.length} lines (limit: ${MAX_ENTRYPOINT_LINES})`
      : `${trimmed.length} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) — index entries are too long`;
  return {
    content: out + `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~150 chars; move detail into topic files.`,
    wasTruncated: true
  };
}

export function buildMemoryPrompt(dir: string, entrypointContent: string): string {
  const index = entrypointContent.trim()
    ? truncateEntrypoint(entrypointContent).content
    : "Your MEMORY.md is currently empty. When you save new memories, they will appear here.";
  return `# Auto memory
You have a persistent, file-based memory system at \`${dir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

Build this memory up over time so future conversations know who the user is, how they like to collaborate, and the context behind the work. If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

## Types of memory
- **user** — the user's role, goals, expertise, and preferences. Save when you learn who they are; use it to tailor explanations and collaboration style.
- **feedback** — guidance on how to work: corrections ("stop doing X") AND confirmations ("perfect, keep doing that"). Record from failure and success. Include *why* so you can judge edge cases later.
- **project** — ongoing work, goals, deadlines, incidents, decisions and their rationale — anything not derivable from the code or git history. Convert relative dates to absolute when saving.
- **reference** — pointers to external systems (dashboards, issue trackers, Slack channels, URLs) and what they are for.

## What NOT to save
- Code patterns, conventions, architecture, file paths, project structure — derivable from the repo.
- Git history or who-changed-what — \`git log\`/\`git blame\` are authoritative.
- Debugging fix recipes — the fix is in the code.
- Anything already in CLAUDE.md.
- Ephemeral task state or current-conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save an activity log, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

## How to save memories
Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g. \`user_role.md\`, \`feedback_testing.md\`) with this frontmatter:

\`\`\`markdown
---
name: short-kebab-slug
description: one-line summary — used to decide relevance in future conversations, so be specific
type: ${MEMORY_TYPES.join(" | ")}
---

memory content — for feedback/project types: the rule/fact, then **Why:** and **How to apply:** lines
\`\`\`

**Step 2** — add a pointer line to \`MEMORY.md\`: \`- [Title](file.md) — one-line hook\` (under ~150 chars). MEMORY.md is an index, not a memory — never write memory content into it. It is always loaded into your context; lines after ${MAX_ENTRYPOINT_LINES} are truncated.

- Update or remove memories that turn out to be wrong or outdated.
- Do not write duplicates — check for an existing file to update first.

## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* memory: proceed as if MEMORY.md were empty — do not apply, cite, or mention memory content.
- Memories reflect what was true when written. Before acting on one, verify against the current state of files or resources; if it conflicts with what you observe now, trust the present and fix or remove the stale memory.

## Before recommending from memory
A memory that names a file, function, or flag is a claim it existed *when written*. Check the file exists or grep for the symbol before recommending it. "The memory says X exists" is not "X exists now."

## MEMORY.md

${index}`;
}
