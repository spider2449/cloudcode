import type { Command, CommandContext } from "./types.js";
import type { PermissionMode } from "../agent/session.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

const commands: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    async run(ctx) {
      const lines = commands.map(c => `/${c.name} — ${c.description}`).join("\n");
      ctx.notice(lines);
    }
  },
  {
    name: "clear",
    description: "Start a new session",
    async run(ctx) { await ctx.clearSession(); ctx.notice("Started a new session."); }
  },
  {
    name: "compact",
    description: "Summarize the conversation to free context",
    async run(ctx) { ctx.sendPrompt("/compact"); }
  },
  {
    name: "init",
    description: "Analyze the codebase and generate CLAUDE.md",
    async run(ctx) { ctx.sendPrompt("/init"); }
  },
  {
    name: "model",
    description: "Switch model: /model <model-name>",
    async run(ctx, args) {
      if (!args) { ctx.notice("Usage: /model <model-name>"); return; }
      await ctx.setModel(args);
      ctx.notice(`Model set to ${args}.`);
    }
  },
  {
    name: "permissions",
    description: "Permission mode or rules: /permissions <default|acceptEdits|bypassPermissions|list|clear>",
    async run(ctx, args) {
      if (args === "list") { ctx.notice(ctx.listPermissionRules()); return; }
      if (args === "clear") { ctx.clearPermissionRules(); ctx.notice("Cleared all permission rules for this project."); return; }
      if (!MODES.includes(args as PermissionMode)) {
        ctx.notice("Valid modes: default, acceptEdits, bypassPermissions");
        return;
      }
      await ctx.setPermissionMode(args as PermissionMode);
      ctx.notice(`Permission mode: ${args}.`);
    },
    completeArgs(prefix) {
      return [...MODES, "list", "clear"].filter(v => v.startsWith(prefix));
    }
  },
  {
    name: "provider",
    description: "Switch LLM provider: /provider <name>",
    async run(ctx, args) {
      if (!args) { ctx.notice(`Providers: ${ctx.providerNames().join(", ")}`); return; }
      await ctx.switchProvider(args);
    },
    completeArgs(prefix, ctx) {
      return ctx.providerNames().filter(v => v.startsWith(prefix));
    }
  },
  {
    name: "resume",
    description: "Pick a past session to resume",
    async run(ctx) { ctx.openResumePicker(); }
  },
  {
    name: "cost",
    description: "Show token/cost usage for this session",
    async run(ctx) { ctx.notice(ctx.costSummary()); }
  },
  {
    name: "mcp",
    description: "Show MCP server status and tools",
    async run(ctx) { ctx.notice(await ctx.mcpStatus()); }
  },
  {
    name: "skills",
    description: "List discovered skills",
    async run(ctx) { ctx.notice(ctx.listSkills()); }
  },
  {
    name: "exit",
    description: "Quit cloudcode",
    async run(ctx) { ctx.exit(); }
  }
];

export function buildRegistry(): Map<string, Command> {
  return new Map(commands.map(c => [c.name, c]));
}
