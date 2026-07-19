import type { McpServersByScope } from "../../agent/mcp.js";

// Static listing for `cloudcode mcp`: which servers are configured and where.
// Deliberately does not connect to any server, so the command stays instant.
export function formatMcpList(scopes: McpServersByScope): string {
  const names = [...new Set([...Object.keys(scopes.user), ...Object.keys(scopes.project)])];
  if (names.length === 0) {
    return "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json.";
  }
  return names
    .map(name => {
      const inUser = name in scopes.user;
      const inProject = name in scopes.project;
      const scope = inProject && inUser ? "project (overrides user)" : inProject ? "project" : "user";
      return `${name}  [${scope}]`;
    })
    .join("\n");
}
