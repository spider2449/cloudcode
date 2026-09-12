import {
  loadMcpServers, loadMcpServersByScope, isMcpServerDisabled,
  resolveMcpServerScope, setMcpServerDisabled, formatMcpStatus
} from "../agent/mcp.js";
import type { AgentSession } from "../agent/session.js";

// Owns the TUI's MCP server inventory: what is configured, what the user
// disabled, and the status/toggle operations over both. The session itself
// stays with App (its lifecycle spans providers, models, and resume); the
// controller only borrows it to read live tool status.
export class McpController {
  private servers: Record<string, Record<string, unknown>> = {};
  private disabled = new Set<string>();

  constructor(private cwd: string) {}

  /** Reload inventory, e.g. when a session (re)connects. Project servers are
   * only visible when the project configuration is trusted. */
  reload(disableMcp: boolean, allowProjectConfig: boolean): void {
    this.servers = disableMcp ? {} : loadMcpServers(this.cwd, undefined, allowProjectConfig);
    const scopes = loadMcpServersByScope(this.cwd);
    const visible = allowProjectConfig
      ? scopes
      : { user: scopes.user, project: {} as typeof scopes.project };
    this.disabled = new Set(
      Object.keys({ ...visible.user, ...visible.project }).filter(name => {
        const effective = visible.project[name] ?? visible.user[name];
        return effective ? isMcpServerDisabled(effective) : false;
      })
    );
  }

  serverNames(): string[] {
    return Array.from(new Set([...Object.keys(this.servers), ...this.disabled]));
  }

  /** The connected-server inventory, handed to a new AgentSession. */
  inventory(): Record<string, Record<string, unknown>> {
    return this.servers;
  }

  async status(session: AgentSession | undefined): Promise<string> {
    return formatMcpStatus(
      [...Object.keys(this.servers), ...this.disabled],
      (await session?.mcpStatus()) ?? [],
      session?.tools ?? [],
      this.disabled
    );
  }

  async setEnabled(name: string, enabled: boolean): Promise<string> {
    const scope = resolveMcpServerScope(name, this.cwd);
    if (!scope) return `No MCP server named "${name}".`;
    if (name.startsWith("pack__")) return `Pack servers cannot be disabled (${name}).`;
    try {
      setMcpServerDisabled(name, !enabled, scope, this.cwd);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
    const verb = enabled ? "Enabled" : "Disabled";
    return `${verb} ${name} (${scope}). Use /clear to reconnect.`;
  }
}
