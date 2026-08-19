import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configDir } from "./providers.js";

export interface ProjectConfigDescriptor {
  projectPath: string;
  digest: string;
  commands: string[];
}

interface TrustRecord {
  projectPath: string;
  digest: string;
}

function canonicalPath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function readConfig(path: string): { raw: string; value: unknown } | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return { raw, value: JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

export function inspectProjectExecutableConfig(cwd: string): ProjectConfigDescriptor | undefined {
  const files: Array<{ name: string; raw: string }> = [];
  const commands: string[] = [];

  const mcp = readConfig(join(cwd, ".mcp.json"));
  if (mcp && mcp.value && typeof mcp.value === "object") {
    const servers = (mcp.value as { mcpServers?: unknown }).mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, raw] of Object.entries(servers)) {
        if (!raw || typeof raw !== "object") continue;
        const cfg = raw as { command?: unknown; args?: unknown };
        const command = cfg.command;
        const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
        if (typeof command === "string" && command !== "") commands.push(`MCP ${name}: ${[command, ...args].join(" ")}`);
      }
      if (commands.some(command => command.startsWith("MCP "))) files.push({ name: ".mcp.json", raw: mcp.raw });
    }
  }

  const lsp = readConfig(join(cwd, ".cloudcode", "lsp.json"));
  if (lsp && lsp.value && typeof lsp.value === "object" && !Array.isArray(lsp.value)) {
    let hasCommand = false;
    for (const [language, raw] of Object.entries(lsp.value)) {
      if (!raw || typeof raw !== "object" || (raw as { enabled?: unknown }).enabled === false) continue;
      const cfg = raw as { command?: unknown; args?: unknown };
      const command = typeof cfg.command === "string" && cfg.command !== "" ? cfg.command : "(inherited command)";
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      const changesExecutableBehavior = Object.keys(raw).some(key => key !== "enabled");
      if (changesExecutableBehavior) {
        commands.push(`LSP ${language}: ${[command, ...args].join(" ")}`);
        hasCommand = true;
      }
    }
    if (hasCommand) files.push({ name: ".cloudcode/lsp.json", raw: lsp.raw });
  }

  if (commands.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.name).update("\0").update(file.raw).update("\0");
  return { projectPath: canonicalPath(cwd), digest: hash.digest("hex"), commands };
}

function isTrustRecord(value: unknown): value is TrustRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TrustRecord>;
  return typeof record.projectPath === "string" && typeof record.digest === "string";
}

export class ProjectTrustStore {
  private records: TrustRecord[] = [];

  constructor(private filePath: string = join(configDir(), "trusted-project-configs.json")) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(raw)) this.records = raw.filter(isTrustRecord);
    } catch {
      // Missing or malformed trust state means no project configuration is trusted.
    }
  }

  isTrusted(descriptor: ProjectConfigDescriptor): boolean {
    return this.records.some(record =>
      canonicalPath(record.projectPath) === descriptor.projectPath && record.digest === descriptor.digest
    );
  }

  approve(descriptor: ProjectConfigDescriptor): void {
    this.records = this.records.filter(record => canonicalPath(record.projectPath) !== descriptor.projectPath);
    this.records.push({ projectPath: descriptor.projectPath, digest: descriptor.digest });
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }
}
