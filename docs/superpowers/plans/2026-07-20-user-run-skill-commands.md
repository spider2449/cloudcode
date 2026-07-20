# User-run Skill Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skill slash commands appear in the `/` autocomplete menu, tagged `(skill)`, so users can discover and run skills themselves.

**Architecture:** Three small, ordered changes. (1) Carry the skill's `source` onto the merged `Command` object. (2) Render a `(skill)` tag in the completion menu for any command that has a `source`. (3) Fix `NativeApp` so the completion context reads the registry live (via a getter) instead of snapshotting the skill-less initial registry, so reloaded skills actually surface.

**Tech Stack:** TypeScript (strict), Vitest, Node ESM (`.js` import specifiers for local modules).

## Global Constraints

- All code, comments, and identifiers in **English only**.
- `tsconfig.json` `strict: true` — no `any`, avoid non-null (`!`) assertions in new code. (Existing test files use `!`/`as unknown as` on fixtures; follow the surrounding test style, but keep production `src/` free of them.)
- Local module imports use `.js` specifiers (ESM), e.g. `../agent/skills.js`.
- Every modified `src/` module keeps its 1:1 test file updated in the same commit.
- Run the full suite with `npx vitest run` (or `npm test`). Lint with `npm run lint`.

---

### Task 1: Carry skill `source` onto the merged Command

**Files:**
- Modify: `src/commands/types.ts` (add optional `source` to `Command`)
- Modify: `src/commands/skillCommands.ts` (set `source` on merged command)
- Test: `tests/skillCommands.test.ts`

**Interfaces:**
- Consumes: `Skill["source"]` from `src/agent/skills.ts` — the union
  `"user" | "claude" | "project" | \`repo:${string}\``.
- Produces: `Command.source?: Skill["source"]` — set only on skill-backed
  commands; undefined on builtins. Task 2 reads this field.

- [ ] **Step 1: Write the failing test**

Add to the `describe("mergeSkillCommands", ...)` block in `tests/skillCommands.test.ts`:

```ts
it("sets source on the merged skill command", () => {
  const merged = mergeSkillCommands(buildRegistry(), [skill]);
  expect(merged.get("commit-helper")!.source).toBe("project");
});

it("leaves builtin commands without a source", () => {
  const merged = mergeSkillCommands(buildRegistry(), [skill]);
  expect(merged.get("help")!.source).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/skillCommands.test.ts`
Expected: FAIL — `source` is `undefined` on the skill command (property does not exist / assertion fails on the first new test).

- [ ] **Step 3: Add the field to the Command interface**

In `src/commands/types.ts`, add an import for `Skill` at the top (alongside the existing imports):

```ts
import type { Skill } from "../agent/skills.js";
```

Then add the optional field to the `Command` interface (after `description`):

```ts
export interface Command {
  name: string;
  description: string;
  /** Present only for skill-backed commands; identifies the skill's origin. */
  source?: Skill["source"];
  run(ctx: CommandContext, args: string): Promise<void>;
  completeArgs?(prefix: string, ctx: CompletionContext): string[];
}
```

- [ ] **Step 4: Set source in mergeSkillCommands**

In `src/commands/skillCommands.ts`, add `source: skill.source` to the object passed to `merged.set(...)`:

```ts
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      async run(ctx, args) {
        ctx.sendPrompt(buildSkillPrompt(skill, args));
      }
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/skillCommands.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add src/commands/types.ts src/commands/skillCommands.ts tests/skillCommands.test.ts
git commit -m "feat: carry skill source onto merged command"
```

---

### Task 2: Tag skills with `(skill)` in the completion menu

**Files:**
- Modify: `src/commands/completion.ts` (`commandNameSuggestions`)
- Test: `tests/completion.test.ts`

**Interfaces:**
- Consumes: `Command.source` (from Task 1). A command is a skill iff `source`
  is defined.
- Produces: for skill commands, the `Suggestion.description` ends with
  ` (skill)`; builtin suggestions are unchanged.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `tests/completion.test.ts` (the file already imports `buildRegistry` and `getSuggestions`):

```ts
describe("skill command tagging", () => {
  function withSkill(): CompletionContext {
    const registry = buildRegistry();
    registry.set("brainstorming", {
      name: "brainstorming",
      description: "Explore ideas into designs",
      source: "user",
      async run() {}
    });
    return ctx({ registry });
  }

  it("appends a (skill) tag to a skill-backed suggestion", () => {
    const s = getSuggestions("/brainst", 8, withSkill());
    expect(s.map(x => x.label)).toEqual(["/brainstorming"]);
    expect(s[0].description).toBe("Explore ideas into designs (skill)");
  });

  it("does not tag builtin commands", () => {
    const s = getSuggestions("/help", 5, withSkill());
    expect(s[0].description).not.toContain("(skill)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/completion.test.ts`
Expected: FAIL — description is `"Explore ideas into designs"` without the ` (skill)` suffix.

- [ ] **Step 3: Add the tag in commandNameSuggestions**

In `src/commands/completion.ts`, change the `.map(...)` in `commandNameSuggestions` so the description is suffixed when the command has a `source`:

```ts
    .map(c => ({
      value: `/${c.name} `,
      label: `/${c.name}`,
      description: c.source ? `${c.description} (skill)` : c.description,
      replaceStart: 0,
      replaceEnd: text.length
    }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/completion.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/commands/completion.ts tests/completion.test.ts
git commit -m "feat: tag skill commands with (skill) in slash menu"
```

---

### Task 3: Make the completion context read the registry live

**Files:**
- Modify: `src/ui/nativeApp.ts` (`completionCtxRef`)

**Interfaces:**
- Consumes: `this.registry`, reassigned by `refreshSkills()` to a new Map that
  includes skill commands.
- Produces: `completionCtx.registry` always returns the current `this.registry`
  (including skills loaded after construction).

**Note on testing:** `NativeApp` has heavy UI/terminal construction
dependencies and no existing unit test file, so this task has no new automated
test — Tasks 1 and 2 cover the observable behavior (skills tagged and surfaced)
against a populated registry. The change here is a one-line getter conversion;
verify via the full build + suite in Step 3 and the manual check in Step 4.

- [ ] **Step 1: Convert registry to a live getter**

In `src/ui/nativeApp.ts`, replace the `completionCtxRef()` method body. Current:

```ts
  private completionCtxRef(): CompletionContext {
    return {
      registry: this.registry,
      providerNames: () => Object.keys(this.props.providers),
      availableModels: () => this.availableModels,
      listFiles: () => this.fileIndex.list(),
      refreshFiles: () => this.fileIndex.refresh()
    };
  }
```

Replace with:

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

- [ ] **Step 2: Type-check and build**

Run: `npm run build`
Expected: builds with no TypeScript errors. (`CompletionContext.registry` is a
plain property in the interface; a getter satisfies it structurally.)

- [ ] **Step 3: Run the full suite and lint**

Run: `npx vitest run` then `npm run lint`
Expected: all tests PASS; lint reports no errors.

- [ ] **Step 4: Manual verification (optional but recommended)**

Create a throwaway skill and confirm it appears in the menu:

```bash
mkdir -p .cloudcode/skills/brainstorming
printf -- '---\nname: brainstorming\ndescription: Explore ideas into designs\n---\nAsk one question at a time.\n' > .cloudcode/skills/brainstorming/SKILL.md
```

Run the app (`npm start` or the project's run command), type `/`, and confirm
`/brainstorming   Explore ideas into designs   (skill)` appears in the
autocomplete list. Then remove the throwaway skill:

```bash
rm -rf .cloudcode/skills/brainstorming
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/nativeApp.ts
git commit -m "fix: read completion registry live so skills appear in slash menu"
```

---

## Self-Review notes

- **Spec coverage:** Change 1 (live registry) → Task 3. Change 2 (source on
  Command) → Task 1. Change 3 (menu tag) → Task 2. Testing section →
  Task 1 Step 1 (source propagation) + Task 2 Step 1 (menu tag & untagged
  builtin). All spec sections mapped.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `Command.source?: Skill["source"]` defined in Task 1 is
  the exact field read in Task 2 and set in Task 1 Step 4; `mergeSkillCommands`
  and `getSuggestions` signatures are used as they exist today.
- **Ordering:** Task 1 must precede Task 2 (Task 2's test sets `source`, which
  only type-checks after the field exists). Task 3 is independent but ordered
  last as the wiring fix.
