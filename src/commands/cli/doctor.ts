import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadProviders, type ProviderConfig } from "../../agent/providers.js";
import { loadRegistry, type ServerConfig } from "../../engine/lsp/config.js";
import { commandExists as realCommandExists } from "../../engine/lsp/detect.js";
import { loadSettings } from "../../agent/settings.js";
import {
  bashNetworkStatus, decideNetwork, providerEndpoint, type NetworkMode
} from "../../agent/networkPolicy.js";
import { sandboxEnablesBash } from "../../agent/sandbox.js";
import { loadOwnCredentials, loadBorrowedCredentials } from "../../agent/oauth.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function checkNodeVersion(version: string = process.version): DoctorCheck {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return { name: "node version", ok: major >= 18, detail: `${version} (need >= 18)` };
}

export function checkConfigDirWritable(dir: string): DoctorCheck {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    return { name: "config dir writable", ok: true, detail: dir };
  } catch (err) {
    return {
      name: "config dir writable",
      ok: false,
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function checkJsonFile(name: string, filePath: string): DoctorCheck {
  if (!existsSync(filePath)) {
    return { name, ok: true, detail: `${filePath} (not present, defaults apply)` };
  }
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
    return { name, ok: true, detail: filePath };
  } catch {
    return { name, ok: false, detail: `${filePath} is not valid JSON` };
  }
}

// Anthropic-kind providers can fall back to the ANTHROPIC_API_KEY env var;
// openai-kind providers must carry an apiKey in providers.json.
export function checkProviderKeys(
  providers: Record<string, ProviderConfig>,
  env: NodeJS.ProcessEnv
): DoctorCheck[] {
  return Object.entries(providers).map(([name, cfg]) => {
    const isOpenai = cfg.kind === "openai";
    const key = cfg.apiKey ?? (isOpenai ? undefined : env.ANTHROPIC_API_KEY);
    return {
      name: `provider "${name}" api key`,
      ok: key !== undefined && key !== "",
      detail: key
        ? "configured"
        : isOpenai
          ? "missing apiKey in providers.json"
          : "set apiKey in providers.json or the ANTHROPIC_API_KEY env var"
    };
  });
}

export function checkLspServers(
  registry: Record<string, ServerConfig> = loadRegistry(),
  exists: (command: string) => boolean = realCommandExists
): DoctorCheck[] {
  return Object.entries(registry).map(([lang, cfg]) => {
    const found = exists(cfg.command);
    return {
      name: `lsp:${lang}`,
      ok: true,
      detail: found ? `${cfg.command} found` : `${cfg.command} not installed (optional)`
    };
  });
}

export function runDoctor(
  opts: { cwd?: string; dir?: string; env?: NodeJS.ProcessEnv; networkMode?: NetworkMode; bashVerified?: boolean } = {}
): DoctorCheck[] {
  const dir = opts.dir ?? configDir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const providersPath = join(dir, "providers.json");
  const providers = loadProviders(providersPath);
  const settings = loadSettings(join(dir, "settings.json"));
  const mode = opts.networkMode ?? settings.networkMode ?? "providerOnly";
  const selectedName = settings.provider ?? "anthropic";
  const selected = providers[selectedName] ?? providers.anthropic ?? {};
  const endpoint = providerEndpoint(selected);
  const providerDecision = decideNetwork(mode, { capability: "provider", destination: endpoint }, endpoint);
  const verified = opts.bashVerified ?? sandboxEnablesBash(mode);
  const bash = bashNetworkStatus(mode, verified);
  return [
    checkNodeVersion(),
    checkConfigDirWritable(dir),
    checkJsonFile("providers.json", providersPath),
    ...checkProviderKeys(providers, env),
    {
      name: "authentication",
      ok: true,
      detail: (() => {
        const own = loadOwnCredentials(dir);
        if (own) return `claude.ai OAuth (expires ${new Date(own.expiresAt).toLocaleString()})`;
        if (env.ANTHROPIC_API_KEY || Object.values(providers).some(p => p.apiKey)) return "api key";
        if (loadBorrowedCredentials()) return "borrowed Claude Code login (~/.claude)";
        return "none configured";
      })()
    },
    {
      name: "network policy",
      ok: providerDecision.allowed,
      detail: `${mode}; provider ${providerDecision.destinationHost} ${providerDecision.allowed ? "allowed" : `denied (${providerDecision.reason})`}`
    },
    {
      name: "Bash network containment",
      ok: true,
      detail: mode === "offlineStrict" && !verified
        ? `${bash.description}; install unshare or bubblewrap to enable contained Bash`
        : `${bash.description}; policy does not claim to contain arbitrary LSP/stdio MCP child egress`
    },
    checkJsonFile("user mcp.json", join(dir, "mcp.json")),
    checkJsonFile("project .mcp.json", join(cwd, ".mcp.json")),
    ...checkLspServers()
  ];
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map(c => `${c.ok ? "ok  " : "FAIL"}  ${c.name}  ${c.detail}`)
    .join("\n");
}
