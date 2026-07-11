# Skill Repos: Install and Update Skills from GitHub

Date: 2026-07-11
Status: Approved

## Goal

Let users install skill collections from GitHub repos (e.g. `https://github.com/obra/superpowers`) and keep them updated via git, managed through a `/skill` builtin command.

## Storage

- Installed repos are full git clones stored at `~/.cloudcode/skill-repos/<owner>--<repo>/`.
- The directory name is derived from the URL: `github.com/obra/superpowers` → `obra--superpowers`.
- No manifest file: the directory listing is the registry, and each clone's `origin` remote records provenance.
- A `git` binary on PATH is required; commands fail with a clear message if it is missing.

## Loading

`loadSkills` in `src/agent/skills.ts` gains a fourth source, scanned after the three existing directories:

1. Enumerate `~/.cloudcode/skill-repos/*/`.
2. Recursively scan each repo for directories containing `SKILL.md`, depth-limited to 5 levels, skipping `.git`, `node_modules`, and dot-directories.
3. Tag discovered skills with source `"repo:<name>"`.

Precedence is unchanged: builtins and skills from user/project directories win on name collision; colliding repo skills are silently skipped, matching current behavior.

## Command Surface

One new builtin `/skill`, registered alongside existing builtins like `/set`, with subcommands:

- `/skill install <github-url>` — normalize the URL (accept `https://github.com/owner/repo` with or without `.git`, and `owner/repo` shorthand), run `git clone --depth 1` into the skill-repos dir, rescan skills, and report how many skills were found. Warn if zero. Error if the repo is already installed.
- `/skill update [name]` — run `git pull --ff-only` in the named repo, or in all installed repos when no name is given. Report per-repo results, then rescan.
- `/skill remove <name>` — delete the repo directory after user confirmation.
- `/skill list` — show installed repos with the skills each provides, plus local (user/project) skills.

Invalid or missing subcommands print usage help.

## Error Handling

- Clone/pull failures surface git's stderr to the user.
- A repo containing zero `SKILL.md` files installs successfully but warns.
- `update`/`remove` with an unknown repo name lists the installed repo names.
- Missing `git` binary produces an actionable error message.

## Testing

- Unit tests for URL normalization (full URL, `.git` suffix, `owner/repo` shorthand, invalid inputs).
- Unit tests for recursive skill scanning using fixture directories, following the style of `tests/skills.test.ts`.
- Git operations wrapped in a small injectable runner interface so command tests can stub clone/pull without touching the network, matching existing test patterns in `tests/skillCommands.test.ts`.

## Out of Scope

- Non-GitHub hosts (though any git URL that clones will incidentally work).
- Version pinning, branches, or tags.
- Automatic update checks.
