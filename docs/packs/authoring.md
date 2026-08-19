# Authoring local workflow packs

A workflow pack is a local directory headed by `cloudcode-pack.json`. cloudcode
never accepts a URL for `pack link`, copies the directory, resolves dependencies,
or contacts a registry. Start from `examples/packs/reference-inert` and validate
against `cloudcode-pack.schema.json` or `cloudcode pack validate <path>`.

## Manifest and capabilities

Manifest version 1 requires a lowercase name, semantic version, description,
capabilities, and resource map. Optional `platforms` and `requiredExecutables`
drive `cloudcode pack doctor`. Unknown top-level keys are retained when the
manifest is inspected so future metadata does not disappear.

- `readProject` and `writeProject` describe intended project access.
- `runProcess` is required for LSP and validation resources.
- `localMcp` is required for stdio MCP resources. URL transports are rejected.
- `network` prevents enablement under `offlineStrict` and `providerOnly`.

All resource paths must remain inside the pack and may not be symlinks. Every
declared file participates in the content digest, so editing instructions or
commands makes the link and project enablement stale.

## Resource formats

`skills` points to a directory containing `<name>/SKILL.md` files. Project,
Claude-compatible, and user skills take precedence over pack skills; pack skills
take precedence over repository-installed skills. Built-in slash commands cannot
be replaced by a skill.

`mcp` uses the existing `{ "mcpServers": { ... } }` format and accepts only
local stdio entries with a `command`. `lsp` maps names to complete entries with
`command`, string `args`, `extensions`, and `rootMarkers`. Both are exposed as
`pack__<pack-name>__<entry-name>` and collisions are rejected.

`validations` uses this shape:

```json
{
  "profiles": {
    "smoke": {
      "commands": [
        { "command": "npm", "args": ["test"], "timeoutMs": 600000 }
      ]
    }
  }
}
```

Profiles are exposed as `<pack-name>:<profile-name>`. MCP, LSP, and validation
commands remain executable project configuration: users must approve the exact
content digest before cloudcode runs them. Packs cannot invoke task services.

`maintenance` may point to the same `{ "profiles": { ... } }` shape used by
`~/.cloudcode/maintenance.json`. Pack maintenance profiles can select exposed
validation profiles, but they cannot call task or worktree services directly.

## Local lifecycle

Run `validate`, then `link`, `inspect`, and `enable --project`. Commit the
generated `.cloudcode/packs.json` if tasks or teammates should use the same exact
pack identity. After changing any declared content, run `link` again, inspect
the new digest, and re-enable it. `disable --project` removes every contribution
from the next session; `unlink --yes` removes only the link record, never files.
