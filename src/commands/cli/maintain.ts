import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  loadMaintenanceProfiles, maintenanceConfigurationDigests, type MaintenanceProfile
} from "../../agent/maintenanceConfig.js";
import {
  listMaintenanceRuns, loadMaintenanceRun, maintenanceRoot, pruneMaintenanceRuns,
  saveMaintenanceRun, type MaintenanceRunOutput
} from "../../agent/maintenanceRuns.js";
import { acquireRunLock, RunLockError } from "../../agent/runLock.js";
import { EXIT_CODES } from "../../print/exitCodes.js";
import { isOutputFormat, type OutputFormat } from "../../print/serialize.js";

export interface MaintainCliResult { exitCode: number; stdout?: string; stderr?: string; }
export type MaintenanceExecutor = (
  profile: MaintenanceProfile, options: { cwd: string; trustProjectConfig: boolean }
) => Promise<MaintenanceRunOutput>;

const USAGE = [
  "Usage:",
  "  cloudcode maintain list",
  "  cloudcode maintain run <profile> [--output-format text|json] [--trust-project-config]",
  "  cloudcode maintain history",
  "  cloudcode maintain show <run-id>"
].join("\n");

export async function runMaintainCommand(args: string[], options: {
  cwd: string; base?: string; execute: MaintenanceExecutor;
  maxRuns?: number; maxBytes?: number;
}): Promise<MaintainCliResult> {
  const [command, ...rest] = args;
  const base = options.base;
  try {
    if (command === "list") {
      if (rest.length) return { exitCode: 2, stderr: USAGE };
      const loaded = loadMaintenanceProfiles(options.cwd, base);
      return { exitCode: loaded.warnings.length ? 2 : 0, stdout: loaded.profiles.map(profile =>
        `${profile.name}  ${profile.execution}  ${profile.networkMode}  ${profile.source}`
      ).join("\n"), ...(loaded.warnings.length ? { stderr: loaded.warnings.join("\n") } : {}) };
    }
    if (command === "history") {
      if (rest.length) return { exitCode: 2, stderr: USAGE };
      const runs = listMaintenanceRuns(options.cwd, base);
      return { exitCode: 0, stdout: runs.length ? runs.map(run =>
        `${run.runId}  ${run.profile}  exit=${run.exitCode}  ${run.comparison}  ${run.startedAt}`
      ).join("\n") : "No maintenance runs for this project." };
    }
    if (command === "show") {
      if (rest.length !== 1) return { exitCode: 2, stderr: USAGE };
      const run = loadMaintenanceRun(options.cwd, rest[0], base);
      return { exitCode: 0, stdout: `${JSON.stringify(run.record, null, 2)}\n\n${run.report}` };
    }
    if (command === "run") {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: {
          "output-format": { type: "string", default: "text" },
          "trust-project-config": { type: "boolean", default: false }
        }
      });
      if (positionals.length !== 1 || !isOutputFormat(values["output-format"]) || values["output-format"] === "stream-json") {
        return { exitCode: 2, stderr: USAGE };
      }
      const loaded = loadMaintenanceProfiles(options.cwd, base);
      if (loaded.warnings.length) return { exitCode: 2, stderr: loaded.warnings.join("\n") };
      const profile = loaded.profiles.find(item => item.name === positionals[0]);
      if (!profile) return { exitCode: 2, stderr: `Maintenance profile not found: ${positionals[0]}.` };
      const lock = acquireRunLock(join(maintenanceRoot(options.cwd, base), "run.lock"));
      const startedAt = new Date();
      try {
        const output = await options.execute(profile, {
          cwd: options.cwd, trustProjectConfig: values["trust-project-config"]
        });
        const digests = maintenanceConfigurationDigests(options.cwd, base);
        const record = saveMaintenanceRun({ cwd: options.cwd, base, profile, output, ...digests, startedAt });
        pruneMaintenanceRuns(options.cwd, {
          base, maxRuns: options.maxRuns ?? 20, maxBytes: options.maxBytes ?? 50 * 1024 * 1024
        });
        const format = values["output-format"] as OutputFormat;
        return {
          exitCode: output.exitCode,
          stdout: format === "json" ? JSON.stringify({ schemaVersion: 1, record, report: output.report })
            : `${output.report}${output.report.endsWith("\n") ? "" : "\n"}\nSaved maintenance run ${record.runId}.`
        };
      } finally { lock.release(); }
    }
    return { exitCode: 2, stderr: USAGE };
  } catch (err) {
    return {
      exitCode: err instanceof RunLockError ? EXIT_CODES.taskConflict : EXIT_CODES.executionError,
      stderr: err instanceof Error ? err.message : String(err)
    };
  }
}
