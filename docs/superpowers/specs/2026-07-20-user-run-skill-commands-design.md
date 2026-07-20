# User-run skill slash commands — design

**Date:** 2026-07-20
**Status:** Approved (design)

## Problem

cloudcode already turns each discovered skill (`SKILL.md` under
`~/.cloudcode/skills/`, `.cloudcode/skills/`, `.claude/skills/`, or an
installed skill repo) into a slash command via `mergeSkillCommands`
(`src/commands/skillCommands.ts`). Running `/<skill>` injects the skill's
markdown as a prompt through `ctx.sendPrompt(...)`, and skills are listed in
the system prompt so the model is told to follow them.

But the **discover-and-run-it-yourself path is broken**: skill commands never
appear in the `/` autocomplete menu. The menu reads from
`completionCtx.registry`, which is captured **once** in the `NativeApp`
constructor (`src/ui/nativeApp.ts` `completionCtxRef()`) as a snapshot of the
initial skill-less `buildRegistry()`. Later, `refreshSkills()` reassigns
`this.registry = mergeSkillCommands(...)`, producing a **new Map**. The command
dispatcher reads `this.registry` live, so typing a skill name blind works — but
the completion context still holds the old, skill-less Map reference and never
shows skills.

Result: users can only run a skill themselves if they already know its exact
name. There is no way to discover a skill from the menu.

## Goal

1. Skill slash commands appear in the `/` autocomplete menu, staying in sync
   when skills are reloaded.
2. Skills are visually tagged `(skill)` in the menu so users can tell them
   apart from builtin commands.

## Changes

### 1. Live registry in the completion context (bug fix)

In `src/ui/nativeApp.ts`, `completionCtxRef()` currently snapshots
`this.registry` by value. Convert `registry` to a getter that closes over the
instance so it always reflects the current Map after `refreshSkills()` swaps
it:

```ts
private completionCtxRef(): CompletionContext {
  const self = this;
  return {
    get registry() { return self.registry; },
    providerNames: () => Object.keys(this.props.providers),
    availableModels: () => this.availableModels,
    listFiles: () => this.fileIndex.list(),
    refreshFiles: () => this.fileIndex.refresh()
  };
}
```

This matches the existing style (the other fields already close over `this`)
and removes any need to re-sync the completion context on reload.

### 2. Carry skill source onto the Command

Add an optional field to the `Command` interface in `src/commands/types.ts`:

```ts
source?: Skill["source"]; // present only for skill-backed commands
```

`mergeSkillCommands` sets `source: skill.source` on each merged command;
builtins leave it undefined. This is the minimal, meaningful hook the menu
needs to distinguish skills (and reuses the `source` concept already surfaced
by `/skills`).

### 3. Tag skills in the menu

In `src/commands/completion.ts` `commandNameSuggestions`, when a command has a
`source`, append `(skill)` to the suggestion's `description`. Builtins (no
`source`) render unchanged. Example rendered row:

```
/brainstorming   Explore ideas into designs   (skill)
```

## Testing

Per the AGENTS.md 1:1 test convention:

- **`tests/completion.test.ts`** — assert that a skill-backed command (a
  `Command` with a `source`) appears in `/` name suggestions, and that its
  suggestion `description` includes the `(skill)` tag while a builtin's does
  not.
- **`tests/skillCommands.test.ts`** (extend or add) — assert
  `mergeSkillCommands` sets `source` on the merged command from the skill's
  source, and leaves existing builtin commands untouched.

A focused unit test for the live-getter behavior in `nativeApp` is not added
here (the class has heavy UI construction dependencies); the completion test
covering a populated registry plus the getter's trivial shape is sufficient
coverage for the fix.

## Out of scope

- A model-invocable Skill tool (autonomous mid-turn skill invocation).
- Loading skill sub-files / `references/*.md`.
- "Using [skill]" announcements on invocation.

These are separate from the user-run discoverability path and are not part of
this change.
