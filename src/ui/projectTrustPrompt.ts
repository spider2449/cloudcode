import { inspectProjectExecutableConfig, ProjectTrustStore } from "../agent/projectTrust.js";

export interface TrustPromptDeps {
  cwd: string;
  openTrust(projectPath: string, commands: string[], resolve: (allow: boolean) => void): void;
  notice(text: string): void;
  onError(text: string): void;
  recompute(): void;
}

/** Resolves whether untrusted project MCP/LSP executable configuration may
 * load. Returns true when trusted/absent; otherwise opens the approval
 * overlay and resolves with the user's decision. */
export function resolveProjectConfigTrust(deps: TrustPromptDeps): boolean | Promise<boolean> {
  const descriptor = inspectProjectExecutableConfig(deps.cwd);
  if (!descriptor) return true;
  const store = new ProjectTrustStore();
  if (store.isTrusted(descriptor)) return true;
  return new Promise(resolve => {
    deps.openTrust(descriptor.projectPath, descriptor.commands, allow => {
      if (allow) {
        try { store.approve(descriptor); }
        catch (err) {
          deps.onError(`Failed to save project trust: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        deps.notice("Ignored untrusted project MCP/LSP configuration.");
      }
      resolve(allow);
    });
    deps.recompute();
  });
}
