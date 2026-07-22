import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadProviders, type ProviderConfig } from "../../agent/providers.js";
import { loadRegistry, type ServerConfig } from "../../engine/lsp/config.js";
import { commandExists as realCommandExists } from "../../engine/lsp/detect.js";

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
  opts: { cwd?: string; dir?: string; env?: NodeJS.ProcessEnv } = {}
): DoctorCheck[] {
  const dir = opts.dir ?? configDir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const providersPath = join(dir, "providers.json");
  return [
    checkNodeVersion(),
    checkConfigDirWritable(dir),
    checkJsonFile("providers.json", providersPath),
    ...checkProviderKeys(loadProviders(providersPath), env),
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
