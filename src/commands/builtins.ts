import type { Command, CommandContext } from "./types.js";
import type { PermissionMode } from "../agent/session.js";
import { THEMES, loadThemeName } from "../ui/theme.js";
import { loadSettings, saveSetting, type Settings } from "../agent/settings.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { resolveProjectPath } from "./projectPath.js";
import {
  installRepo, updateRepos, removeRepo, listRepoNames,
  skillReposDir, userSkillsDir, defaultGitRunner
} from "../agent/skillRepos.js";
import { EFFORT_LEVELS, isEffortLevel } from "../engine/effort.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

const CONFIG_KEYS = ["provider", "model", "permissionMode", "theme", "effort", "autoMemory"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

function contextReport(info: ReturnType<CommandContext["contextInfo"]>): string {
  const { snapshot, model, contextWindow } = info;
  if (!snapshot) return "No context yet — send a message first.";
  const estimateSum = snapshot.systemTokens + snapshot.toolsTokens + snapshot.messagesTokens;
  const real = snapshot.inputTokens;
  const scale = real !== undefined && estimateSum > 0 ? real / estimateSum : 1;
  const total = real ?? estimateSum;
  const rows: Array<[string, number]> = [
    ["System prompt", Math.round(snapshot.systemTokens * scale)],
    ["Tools", Math.round(snapshot.toolsTokens * scale)],
    ["Messages", Math.round(snapshot.messagesTokens * scale)],
    ["Free space", Math.max(0, contextWindow - total)]
  ];
  const pct = (n: number) => contextWindow > 0
    ? `${Math.min(100, Math.max(0, (n / contextWindow) * 100)).toFixed(1)}%`
    : "0.0%";
  const totalPct = contextWindow > 0 ? Math.min(100, Math.round((total / contextWindow) * 100)) : 0;
  const suffix = real === undefined ? " (estimated)" : "";
  const header = `Context usage — ${model} (${fmtK(total)} / ${fmtK(contextWindow)} tokens (${totalPct}%))${suffix}`;
  const body = rows
    .map(([label, n]) => `  ${label.padEnd(15)}${fmtK(n).padStart(7)}  ${pct(n).padStart(5)}`)
    .join("\n");
  return `${header}\n\n${body}`;
}

function configValue(key: ConfigKey): string {
  if (key === "theme") return loadThemeName();
  if (key === "effort") return loadSettings().effort ?? "off";
  if (key === "autoMemory") return String(loadSettings().autoMemoryEnabled ?? true);
  return loadSettings()[key as keyof Omit<Settings, "effort" | "autoMemoryEnabled">] ?? "(unset)";
}

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
    async run(ctx) {
      ctx.setCompactProgress(0);
      try {
        await ctx.compact(pct => ctx.setCompactProgress(pct));
      } finally {
        ctx.setCompactProgress(undefined);
      }
      ctx.notice("Conversation compacted.");
    }
  },
  {
    name: "config",
    description: "Get/set startup defaults: /config [provider|model|permissionMode|theme] [value]",
    async run(ctx, args) {
      const [key, ...rest] = args.split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!key) {
        ctx.notice(CONFIG_KEYS.map(k => `${k} = ${configValue(k)}`).join("\n"));
        return;
      }
      if (!CONFIG_KEYS.includes(key as ConfigKey)) {
        ctx.notice(`Unknown key: ${key}. Keys: ${CONFIG_KEYS.join(", ")}`);
        return;
      }
      if (!value) {
        ctx.notice(`${key} = ${configValue(key as ConfigKey)}`);
        return;
      }
      switch (key as ConfigKey) {
        case "provider":
          if (!ctx.providerNames().includes(value)) {
            ctx.notice(`Unknown provider: ${value}. Providers: ${ctx.providerNames().join(", ")}`);
            return;
          }
          saveSetting("provider", value);
          await ctx.switchProvider(value);
          break;
        case "model":
          saveSetting("model", value);
          await ctx.setModel(value);
          break;
        case "permissionMode":
          if (!MODES.includes(value as PermissionMode)) {
            ctx.notice("Valid modes: default, acceptEdits, bypassPermissions");
            return;
          }
          if (value === "bypassPermissions") {
            await ctx.setPermissionMode(value);
            ctx.notice("permissionMode = bypassPermissions (session only, not saved)");
            return;
          }
          saveSetting("permissionMode", value);
          await ctx.setPermissionMode(value as PermissionMode);
          break;
        case "effort":
          if (!isEffortLevel(value)) {
            ctx.notice(`Unknown level: ${value}. Levels: ${EFFORT_LEVELS.join(", ")}`);
            return;
          }
          saveSetting("effort", value);
          await ctx.setEffort(value);
          break;
        case "autoMemory": {
          if (value !== "true" && value !== "false") {
            ctx.notice("Valid values: true, false");
            return;
          }
          saveSetting("autoMemoryEnabled", value === "true");
          break;
        }
        case "theme":
          if (!(value in THEMES)) {
            ctx.notice(`Unknown theme: ${value}. Themes: ${Object.keys(THEMES).join(", ")}`);
            return;
          }
          ctx.setTheme(value);
          break;
      }
      ctx.notice(`${key} = ${value} (saved)`);
    },
    completeArgs(prefix, cctx) {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) return CONFIG_KEYS.filter(k => k.startsWith(parts[0] ?? ""));
      const [key, valuePrefix = ""] = parts;
      const values =
        key === "provider" ? cctx.providerNames() :
        key === "permissionMode" ? MODES :
        key === "theme" ? Object.keys(THEMES) :
        key === "effort" ? [...EFFORT_LEVELS] :
        key === "autoMemory" ? ["true", "false"] :
        key === "model" ? cctx.availableModels() : [];
      return values.filter(v => v.startsWith(valuePrefix)).map(v => `${key} ${v}`);
    }
  },
  {
    name: "context",
    description: "Show context window usage breakdown",
    async run(ctx) {
      ctx.notice(contextReport(ctx.contextInfo()));
    }
  },
  {
    name: "init",
    description: "Analyze the codebase and generate CLAUDE.md",
    async run(ctx) { ctx.sendPrompt("/init"); }
  },
  {
    name: "model",
    description: "Switch model: /model <model-name>; no arg lists available models",
    async run(ctx, args) {
      if (!args) {
        const models = ctx.availableModels();
        if (models.length === 0) {
          ctx.notice("Usage: /model <model-name> (model list unavailable for this provider)");
          return;
        }
        const current = ctx.currentModel();
        ctx.notice(models.map(m => `${m === current ? "●" : " "} ${m}`).join("\n"));
        return;
      }
      saveSetting("model", args);
      await ctx.setModel(args);
      ctx.notice(`Model set to ${args}.`);
    },
    completeArgs(prefix, cctx) {
      return cctx.availableModels().filter(m => m.startsWith(prefix));
    }
  },
  {
    name: "new",
    description: "Start a new session and show the welcome screen",
    async run(ctx) { await ctx.clearSession(); }
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
      if (!ctx.providerNames().includes(args)) {
        ctx.notice(`Unknown provider: ${args}. Providers: ${ctx.providerNames().join(", ")}`);
        return;
      }
      saveSetting("provider", args);
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
    name: "set",
    description: "Set session values: /set project [path] (no path: pick a recent project)",
    async run(ctx, args) {
      const [key, ...rest] = args.split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!key) { ctx.notice("Usage: /set project [path]"); return; }
      if (key !== "project") { ctx.notice(`Unknown /set key: ${key}. Keys: project`); return; }
      if (!value) { ctx.openProjectPicker(); return; }
      const result = resolveProjectPath(value, ctx.currentCwd());
      if (!result.ok) { ctx.notice(result.error); return; }
      ctx.switchProject(result.path);
    },
    completeArgs(prefix) {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) return ["project"].filter(k => k.startsWith(parts[0] ?? ""));
      if (parts[0] !== "project") return [];
      const typed = parts.slice(1).join(" ");
      const expanded =
        typed === "~" ? homedir() :
        typed.startsWith("~/") || typed.startsWith("~\\") ? resolve(homedir(), typed.slice(2)) :
        typed;
      const base = resolve(process.cwd(), expanded || ".");
      // If the typed text doesn't end with a separator, complete within its parent.
      const endsWithSep = typed.endsWith("/") || typed.endsWith("\\") || typed === "";
      const dir = endsWithSep ? base : dirname(base);
      const frag = endsWithSep ? "" : basename(base).toLowerCase();
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.toLowerCase().startsWith(frag))
          .slice(0, 20)
          .map(d => `project ${join(endsWithSep ? typed : dirname(typed || "."), d.name)}`);
      } catch {
        return [];
      }
    }
  },
  {
    name: "cost",
    description: "Show token/cost usage for this session",
    async run(ctx) { ctx.notice(ctx.costSummary()); }
  },
  {
    name: "effort",
    description: "Set reasoning effort: /effort <off|low|medium|high>; no arg lists levels",
    async run(ctx, args) {
      if (!args) {
        const current = ctx.currentEffort();
        ctx.notice(EFFORT_LEVELS.map(l => `${l === current ? "●" : " "} ${l}`).join("\n"));
        return;
      }
      if (!isEffortLevel(args)) {
        ctx.notice(`Unknown level: ${args}. Levels: ${EFFORT_LEVELS.join(", ")}`);
        return;
      }
      saveSetting("effort", args);
      await ctx.setEffort(args);
      ctx.notice(`Effort: ${args}`);
    },
    completeArgs(prefix) {
      return EFFORT_LEVELS.filter(l => l.startsWith(prefix));
    }
  },
  {
    name: "memory",
    description: "Edit memory files (user CLOUDCODE.md, project CLAUDE.md, auto-memory folder)",
    async run(ctx) { ctx.openMemoryPicker(); }
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
    name: "skill",
    description: "Manage skill repos: /skill install <github-url> | update [name] | remove <name> --yes | list",
    async run(ctx, args) {
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const usage = "Usage: /skill install <github-url> | update [name] | remove <name> --yes | list";
      const reposDir = skillReposDir();
      const skillsDir = userSkillsDir();
      switch (sub) {
        case "install": {
          if (!rest[0]) { ctx.notice(usage); return; }
          ctx.notice(await installRepo(rest[0], reposDir, skillsDir, defaultGitRunner));
          ctx.reloadSkills();
          return;
        }
        case "update": {
          ctx.notice(await updateRepos(rest[0], reposDir, skillsDir, defaultGitRunner));
          ctx.reloadSkills();
          return;
        }
        case "remove": {
          if (!rest[0]) { ctx.notice(usage); return; }
          if (rest[1] !== "--yes") {
            ctx.notice(`This deletes ${join(reposDir, rest[0])}. Re-run: /skill remove ${rest[0]} --yes`);
            return;
          }
          ctx.notice(removeRepo(rest[0], reposDir, skillsDir));
          ctx.reloadSkills();
          return;
        }
        case "list": {
          const names = listRepoNames(reposDir);
          if (names.length === 0) {
            ctx.notice("No skill repos installed. Use /skill install <github-url>.\n\n" + ctx.listSkills());
            return;
          }
          const repoLines = names.map(name => {
            let skillNames = "(no skills)";
            try {
              const linked = readdirSync(join(skillsDir, name), { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => `/${e.name}`);
              if (linked.length) skillNames = linked.join(", ");
            } catch {
              // no linked skills for this repo yet
            }
            return `${name}: ${skillNames}`;
          });
          ctx.notice(repoLines.join("\n") + "\n\nAll skills:\n" + ctx.listSkills());
          return;
        }
        default:
          ctx.notice(usage);
      }
    },
    completeArgs(prefix) {
      const parts = prefix.split(/\s+/);
      const subs = ["install", "update", "remove", "list"];
      if (parts.length <= 1) return subs.filter(s => s.startsWith(parts[0] ?? ""));
      const [sub, frag = ""] = parts;
      if (sub === "update" || sub === "remove") {
        return listRepoNames(skillReposDir())
          .filter(n => n.startsWith(frag))
          .map(n => `${sub} ${n}`);
      }
      return [];
    }
  },
  {
    name: "theme",
    description: "Switch color theme: /theme <name> (no arg lists themes)",
    async run(ctx, args) {
      if (!args) { ctx.notice(ctx.listThemes()); return; }
      if (!(args in THEMES)) {
        ctx.notice(`Unknown theme: ${args}. Themes: ${Object.keys(THEMES).join(", ")}`);
        return;
      }
      ctx.setTheme(args);
      ctx.notice(`Theme: ${args}`);
    },
    completeArgs(prefix) {
      return Object.keys(THEMES).filter(v => v.startsWith(prefix));
    }
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
