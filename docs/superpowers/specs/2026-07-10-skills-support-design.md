# Skills Support Design

Date: 2026-07-10
Status: Approved

## Goal

Let cloudcode discover skills — directories containing a `SKILL.md` with
frontmatter and instructions — and invoke them as slash commands that send
the skill's instructions to the model as a prompt. A `/skills` builtin lists
what was discovered.

## Non-goals

- SDK-native skill loading (settingSources/plugins/Skill tool) — skills here
  are user-invoked prompt injection only.
- Supporting extra skill files beyond `SKILL.md` (scripts, references) — the
  model can read those itself via its file tools once the instructions
  mention them.
- Hot reload — new/edited skills are picked up on the next session
  (`/clear`), same as MCP config.
- Full YAML parsing — only simple `key: value` frontmatter lines are read.

## Skill format

Claude Code's format: a directory whose `SKILL.md` starts with YAML
frontmatter followed by markdown instructions:

```markdown
---
name: commit-helper
description: Write a conventional commit from staged changes
---

Instructions the model follows...
```

- `name` falls back to the directory name when absent; `description` falls
  back to `""`.
- A file with no frontmatter block (`---` ... `---`) is skipped.

## Discovery — `src/agent/skills.ts`

```ts
interface Skill {
  name: string;
  description: string;
  content: string;   // instructions (frontmatter stripped), read eagerly
  source: "user" | "claude" | "project";
}

loadSkills(cwd: string, userDir?: string): Skill[]
```

Scan order, later wins on name conflict:

1. `~/.cloudcode/skills/<dir>/SKILL.md` — user (`userDir` defaults to
   `join(configDir(), "skills")`).
2. `<cwd>/.claude/skills/<dir>/SKILL.md` — Claude Code compatibility.
3. `<cwd>/.cloudcode/skills/<dir>/SKILL.md` — project.

Missing directories, unreadable files, and malformed frontmatter contribute
nothing (same tolerance as `loadProviders` / `loadMcpServers`).

## Invocation

Each discovered skill registers as a slash command `/<name> [args]`:

- App merges skills into the command registry after `buildRegistry()`;
  a skill whose name collides with a builtin is skipped (builtin wins).
- Running the command calls a new `CommandContext.sendPrompt(text)` with:
  `content` + (`"\n\nARGUMENTS: " + args` when args are non-empty).
- `sendPrompt` follows the exact same path as a normal input submit in App
  (records first message, adds a user transcript item, sets streaming phase,
  sends) — the transcript shows the injected prompt as a user turn.
- Skills appear in the autocomplete menu automatically via the registry,
  with their descriptions.

Skills are loaded in `createSession` alongside `loadMcpServers`, stored in a
ref, so `/clear`, provider switch, and resume re-discover them.

## `/skills` builtin

Lists discovered skills, one per line: `/<name>  <description>  (<source>)`.
When none: "No skills found. Add them to .cloudcode/skills/&lt;name&gt;/SKILL.md
or ~/.cloudcode/skills/."

Implemented via `CommandContext.listSkills(): string` provided by App.

## Error handling

- Invoking while streaming is impossible — the input box is disabled.
- Content is read eagerly at discovery, so a file deleted afterwards still
  invokes with the cached content.
- Discovery never throws; worst case is an empty skill list.

## Testing

- `tests/skills.test.ts` — frontmatter parsing (name/description, name
  fallback to dir name), precedence (project > claude > user), missing
  dirs, file without frontmatter skipped, content excludes frontmatter.
- `tests/commands.test.ts` — `/skills` listing and empty message; a
  registered skill command calls `sendPrompt` with and without args;
  builtin collision (skill named "help" does not override).
- Registry merge logic covered via an App-level unit or a pure helper
  `mergeSkillCommands(registry, skills)` tested directly.
