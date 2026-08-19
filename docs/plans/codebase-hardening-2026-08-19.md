# Codebase hardening after the 2026-08-19 review

## Goal

Close the six verified review findings without weakening the existing permission
model, provider abstraction, or startup behavior. Security-sensitive changes land
first, and every production change includes focused regression coverage in the
same commit.

## Scope and design decisions

- Treat user-global MCP/LSP configuration as explicitly installed by the user.
- Treat repository-owned `.mcp.json` and `.cloudcode/lsp.json` as untrusted
  executable configuration until the user approves the exact configuration for
  that project.
- Store project trust in the agent/configuration layer, keyed by canonical
  project path and a digest of the executable configuration. Re-prompt when
  either file changes.
- Interactive mode may show the trust prompt. Non-interactive print mode must
  ignore untrusted project executable configuration unless an explicit CLI flag
  opts in; it must never block waiting for terminal input.
- Keep the memory extractor limited to its memory directory. It does not need
  access to project files or arbitrary absolute paths.
- Preserve `EngineLoop`'s sequential content-block contract. The OpenAI adapter
  must buffer tool calls by provider index and emit each logical call once.

## Implementation plan

### 1. Add one trust boundary for project MCP and LSP configuration

1. Add `src/agent/projectTrust.ts` to own canonical-path handling, configuration
   hashing, trust-file loading/saving, and validation. Persist records under the
   existing cloudcode configuration directory; malformed files fall back safely
   to no trusted projects.
2. Refactor MCP and LSP configuration loading to preserve user and project
   scopes instead of merging executable project entries before trust is known.
3. Add a startup trust request containing the project path and the commands that
   would execute. Approval records the digest; denial ignores only the project
   entries and keeps built-in/user-global configuration available.
4. Wire the request through `src/ui/nativeApp.ts` using a dedicated controller
   or picker rather than adding state ownership back to `App`.
5. Add `--trust-project-config` for print mode. Without it, print mode reports a
   concise warning on stderr and excludes untrusted project MCP/LSP entries.
6. Cover canonical path aliases, Windows case folding, changed configuration
   digests, malformed trust files, denial, approval, project switching, and
   non-interactive behavior. Add a regression proving that merely starting in a
   repository with a project MCP command does not spawn it before approval.

### 2. Confine background memory extraction reads

1. In `src/engine/extractMemories.ts`, apply the memory-directory path guard to
   `Read` as well as `Write` and `Edit`. Resolve relative paths against the same
   directory passed to each tool.
2. Return an error tool result for every out-of-scope read without invoking the
   file tool. Keep the extraction loop alive so the model can recover.
3. Add tests for absolute escapes, `..` escapes, allowed reads of existing
   memory files, and a captured follow-up provider request proving secret file
   contents were never inserted into model messages.

### 3. Preserve parallel OpenAI-compatible tool calls

1. Replace the single `open` tool-call identity in `src/engine/openaiApi.ts`
   with an accumulator keyed by the provider's tool-call index. Merge streamed
   ID, function name, and argument fragments into the same logical call.
2. Continue streaming text and reasoning normally, then emit each accumulated
   tool call exactly once in index order using the sequential Anthropic-shaped
   events expected by `EngineLoop`.
3. Reject or surface a provider error for a completed call missing an ID or
   function name instead of emitting an executable block with empty identity.
4. Add adapter and engine integration tests for two interleaved calls across
   multiple chunks, multiple calls in one chunk, fragmented arguments, and a
   malformed incomplete call.

### 4. Make MCP tools available before the first request

1. Give `AgentSession` an explicit readiness promise that resolves after MCP
   connections have either succeeded or entered their existing failed state.
2. Queue `send()` behind readiness while preserving interrupt behavior and the
   current per-turn error boundary. Do not allow multiple queued first turns.
3. Ensure print mode awaits readiness before beginning its single turn. Update
   the session tool list before the first API request is assembled.
4. Add an injectable MCP manager/factory for focused session tests. Verify a
   delayed connection is included in the first request, a failed connection
   does not block it, and interruption during startup prevents tool execution.

### 5. Make LSP teardown and cancellation idempotent

1. Separate process termination from the `dead` protocol-state guard in
   `src/engine/lsp/server.ts`. `stop()` must attempt to kill an existing child
   even when initialization has already marked the server dead.
2. Clear the stored process reference after termination and make repeated
   `stop()` calls harmless.
3. Reject `request()` immediately when passed an already-aborted signal; do not
   allocate a pending entry or write a JSON-RPC request.
4. Extend LSP tests with a kill spy for initialization timeout, repeated stop,
   process error, and pre-aborted requests. Assert that the pending-request map
   and abort listeners are cleaned up.

### 6. Start resumed-session extraction at the resume boundary

1. After loading resumed messages in `AgentSession.start()`, initialize
   `extractCursor` to the loaded history length.
2. Keep the existing compact-history cursor reset unchanged.
3. Add a session integration test proving the first post-resume extraction sees
   only newly appended messages and does not resend the historical transcript.

## Delivery sequence

Use focused commits in this order:

1. Project executable-configuration trust boundary.
2. Memory extractor read confinement.
3. OpenAI parallel tool-call translation.
4. MCP first-turn readiness.
5. LSP lifecycle and cancellation hardening.
6. Resume extraction cursor correction.

After each commit, run its focused tests. After all commits, run:

```powershell
npm run lint
npm run lint:size
npm run build
npm test
npm audit --audit-level=high
```

## Completion criteria

- No repository-controlled MCP or LSP command starts without explicit trust for
  the current configuration digest.
- The memory extractor cannot read or transmit files outside its memory
  directory.
- Interleaved OpenAI tool calls produce one complete engine tool block per
  provider call.
- MCP tools are present in the first interactive and print-mode API requests.
- Failed or cancelled LSP startup leaves no child process or pending request.
- Resuming a session does not re-extract its prior transcript.
- Lint, size checks, build, tests, and the high-severity dependency audit pass.
