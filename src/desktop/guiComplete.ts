import { getSuggestions, type Suggestion } from "../commands/completion.js";
import { buildRegistry } from "../commands/builtins.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";
import { loadSkills } from "../agent/skills.js";
import { loadMcpServers } from "../agent/mcp.js";
import type { ProviderConfig } from "../agent/providers.js";

export interface GuiCompleteDeps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  availableModels: string[];
}

// Argument (and command-name) suggestions for the GUI input box, using the
// same getSuggestions machinery as the terminal input box so both surfaces
// complete identically. Returned Suggestion values carry replaceStart/End so
// applying one preserves the command prefix (clicking "github" for "/theme "
// yields "/theme github", never a bare "github" prompt).
// File (@mention) suggestions are intentionally empty: the backend has no
// file index; that stays a follow-up.
export function suggestCompletions(text: string, deps: GuiCompleteDeps): Suggestion[] {
  if (!text.startsWith("/")) return [];
  const registry = mergeSkillCommands(
    buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" }),
    loadSkills(deps.cwd)
  );
  return getSuggestions(text, text.length, {
    registry,
    providerNames: () => Object.keys(deps.providers),
    availableModels: () => deps.availableModels,
    mcpServerNames: () => Object.keys(loadMcpServers(deps.cwd)),
    listFiles: () => []
  });
}
