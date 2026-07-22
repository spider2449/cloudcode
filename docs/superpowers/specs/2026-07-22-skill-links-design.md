# Skill Repo Linking Design

**Date:** 2026-07-22
**Status:** Approved

## Problem

Skill repos are cloned into `<configDir>/skill-repos/<owner--repo>` and `loadSkills` recursively walks every installed repo (depth 5) on every load to discover skills. This makes discovery cost scale with repo size and count.

## Goal

Move the recursive repo walk to install time. At runtime, discovery only scans `skills/` directories. Repo skills are exposed via directory links created under `<configDir>/skills/<repo>/<skill>`.

## Design

### Link mechanism

Use `fs.symlinkSync(target, linkPath, "junction")`:

- On Windows this creates a directory junction (no admin rights or Developer Mode required).
- On POSIX the `"junction"` type is ignored and a normal symlink is created.

Links point at the skill's directory inside `skill-repos/`, so a `git pull` updates skill content in place without relinking. Relinking is only needed when skills are added, removed, or moved — handled by the update flow.

### Layout

```
<configDir>/
  skill-repos/
    anthropics--skills/            # git clone (unchanged)
      document-skills/pdf/SKILL.md
  skills/
    my-local-skill/SKILL.md        # user skill (unchanged, flat)
    anthropics--skills/            # namespace dir per installed repo
      pdf -> ../../skill-repos/anthropics--skills/document-skills/pdf
```

Namespacing per repo avoids name collisions between repos and with local skills, and makes remove/update a simple directory wipe.

### Install (`installRepo`)

After a successful clone:

1. Scan the cloned repo with the existing `scanRepoSkills` walk.
2. Create `<configDir>/skills/<repoDirName>/` and one junction/symlink per found skill, named after the skill, targeting the skill's directory in the clone.

### Update (`updateRepos`)

After `git pull` for a repo: delete `skills/<repo>/` and relink from a fresh scan. This handles added, removed, and renamed skills.

### Remove (`removeRepo`)

Delete both `skill-repos/<repo>` and `skills/<repo>`.

### Discovery (`loadSkills`)

Drop the per-repo recursive walk. Each skills dir (user `<configDir>/skills`, project `.cloudcode/skills`, `.claude/skills`) is scanned with a shallow recursive scan, depth 2:

- A directory containing `SKILL.md` is a skill (leaf).
- A first-level directory without `SKILL.md` is a namespace; its immediate children are scanned for `SKILL.md`.

Source attribution: a skill found under `skills/<sub>/` where `<sub>` exists as a directory in `skill-repos/` gets source `repo:<sub>`; all other skills keep their dir's source (`user` / `project` / `claude`).

Precedence is unchanged: local skills override repo skills via existing `byName` map insertion order (repo skills only fill names not already taken).

### Backfill (migration)

In `loadSkills`: for each repo present in `skill-repos/` that has no corresponding `skills/<repo>/` directory, run the install-time link step once. Steady-state cost is one directory-existence check per installed repo. Existing installs keep working with zero user action.

### Edge cases

- **Link creation failure** (exotic filesystem): skip that skill with the repo clone intact; the skill becomes discoverable after a manual fix or `/skill update`.
- **Duplicate skill names across repos**: first-wins, as today.
- **Empty repo (no skills)**: install still reports "no skills"; no `skills/<repo>/` namespace dir is created. The backfill check treats a repo with no namespace dir as needing a link pass, so empty repos are re-scanned on load — acceptable, since the scan of an empty repo is cheap.

## Testing

- `tests/skillRepos.test.ts`: links created on install; relinked on update; both dirs removed on remove; backfill creates links for pre-existing repos.
- `tests/skills.test.ts`: namespaced (depth-2) scan; source attribution for repo-namespaced skills; local-over-repo precedence.
- Update existing tests that rely on runtime repo-walking in `loadSkills`.
