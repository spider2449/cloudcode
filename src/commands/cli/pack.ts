import { parseArgs } from "node:util";
import type { NetworkMode } from "../../agent/networkPolicy.js";
import {
  currentLinkedPack, linkPack, loadPackLinks, unlinkPack
} from "../../agent/packLinks.js";
import { validatePackDirectory } from "../../agent/packManifest.js";
import { disablePack, enablePack, packDoctor } from "../../agent/packs.js";
import { EXIT_CODES } from "../../print/exitCodes.js";

export interface PackCliResult { exitCode: number; stdout?: string; stderr?: string; }

const USAGE = [
  "Usage:",
  "  cloudcode pack validate <local-path>",
  "  cloudcode pack link <local-path>",
  "  cloudcode pack list",
  "  cloudcode pack inspect <name>",
  "  cloudcode pack enable <name> --project",
  "  cloudcode pack disable <name> --project",
  "  cloudcode pack unlink <name> --yes",
  "  cloudcode pack doctor"
].join("\n");

function inspect(name: string, base?: string): string {
  const current = currentLinkedPack(name, base);
  return JSON.stringify({
    name: current.link.name, version: current.link.version, path: current.link.path,
    linkedDigest: current.link.digest, currentDigest: current.pack.digest, stale: current.stale,
    manifest: current.pack.manifest
  }, null, 2);
}

export function runPackCommand(args: string[], options: {
  cwd: string; base?: string; networkMode: NetworkMode;
}): PackCliResult {
  const [command, ...rest] = args;
  try {
    if (command === "validate") {
      if (rest.length !== 1) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      const result = validatePackDirectory(rest[0]);
      return result.ok
        ? { exitCode: 0, stdout: JSON.stringify({ valid: true, ...result.pack }, null, 2) }
        : { exitCode: EXIT_CODES.invalidConfiguration, stderr: result.errors.join("\n") };
    }
    if (command === "link") {
      if (rest.length !== 1) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      const link = linkPack(rest[0], options.base);
      return { exitCode: 0, stdout: `Linked ${link.name}@${link.version}\nPath: ${link.path}\nDigest: ${link.digest}` };
    }
    if (command === "list") {
      if (rest.length) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      const links = loadPackLinks(options.base);
      const lines = links.map(link => {
        try { return `${link.name}@${link.version}  ${currentLinkedPack(link.name, options.base).stale ? "stale" : "ready"}  ${link.path}`; }
        catch { return `${link.name}@${link.version}  unavailable  ${link.path}`; }
      });
      return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No local workflow packs linked." };
    }
    if (command === "inspect") {
      if (rest.length !== 1) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      return { exitCode: 0, stdout: inspect(rest[0], options.base) };
    }
    if (command === "enable" || command === "disable") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { project: { type: "boolean", default: false } }
      });
      if (positionals.length !== 1 || !values.project) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      if (command === "enable") enablePack(positionals[0], options.cwd, options.networkMode, options.base);
      else disablePack(positionals[0], options.cwd);
      return { exitCode: 0, stdout: `${command === "enable" ? "Enabled" : "Disabled"} ${positionals[0]} for this project.` };
    }
    if (command === "unlink") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { yes: { type: "boolean", default: false } }
      });
      if (positionals.length !== 1) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      unlinkPack(positionals[0], values.yes, options.base);
      return { exitCode: 0, stdout: `Unlinked ${positionals[0]}. Pack files were not removed.` };
    }
    if (command === "doctor") {
      if (rest.length) return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
      const items = packDoctor(options.base);
      return {
        exitCode: items.some(item => !item.ok) ? EXIT_CODES.executionError : 0,
        stdout: items.length ? items.map(item => `${item.ok ? "ok" : "fail"}  ${item.name}  ${item.details.join("; ")}`).join("\n")
          : "No local workflow packs linked."
      };
    }
    return { exitCode: EXIT_CODES.invalidConfiguration, stderr: USAGE };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const networkDenied = command === "enable" && /network capability/.test(message);
    const conflict = /stale|changed since it was linked|collision|already linked|not linked/.test(message);
    return {
      exitCode: networkDenied ? EXIT_CODES.networkDenied : conflict ? EXIT_CODES.taskConflict : EXIT_CODES.invalidConfiguration,
      stderr: message
    };
  }
}
