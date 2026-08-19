import type { ProviderConfig } from "../../agent/providers.js";
import type { EffortLevel } from "../../engine/effort.js";
import { runPrint, type PrintOptions } from "../../printMode.js";
import { SessionIndex } from "../../agent/sessionIndex.js";
import { NetworkAudit } from "../../agent/networkAudit.js";
import { runIsolatedMaintenanceVerification } from "../../agent/maintenanceExecution.js";
import type { MaintenanceExecutor } from "./maintain.js";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Definition", "References", "Hover", "Symbols", "Diagnostics"];

export function createMaintenanceExecutor(options: {
  providerName: string; provider: ProviderConfig; model?: string; effort?: EffortLevel;
  savedNetworkMode?: "offlineStrict" | "providerOnly";
  sessionIndex?: SessionIndex; networkAudit?: NetworkAudit;
  runPrintFn?: typeof runPrint; isolatedFn?: typeof runIsolatedMaintenanceVerification;
}): MaintenanceExecutor {
  return async (profile, run) => {
    if (profile.execution === "isolatedVerification") {
      return (options.isolatedFn ?? runIsolatedMaintenanceVerification)({
        cwd: run.cwd, profile, trustProjectConfig: run.trustProjectConfig
      });
    }
    let events = "";
    let diagnostics = "";
    const mode = options.savedNetworkMode === "offlineStrict" ? "offlineStrict" : profile.networkMode;
    const printOptions: PrintOptions = {
      prompt: `${profile.prompt}\n\nThis is a bounded maintenance analysis. Do not propose continuing into implementation.`,
      providerName: options.providerName, provider: options.provider, model: options.model, effort: options.effort,
      permissionMode: "default", cwd: run.cwd,
      sessionIndex: options.sessionIndex ?? new SessionIndex(),
      networkAudit: options.networkAudit ?? new NetworkAudit(),
      trustProjectConfig: run.trustProjectConfig, networkMode: mode,
      outputFormat: "stream-json", runLimits: profile.limits,
      toolAllowlist: READ_ONLY_TOOLS, disableMcp: true
    };
    const exitCode = await (options.runPrintFn ?? runPrint)(printOptions, {
      out: text => { events += text; }, err: text => { diagnostics += text; }
    });
    let report = "";
    let sessionId: string | undefined;
    for (const line of events.split(/\r?\n/).filter(Boolean)) {
      try {
        const envelope = JSON.parse(line) as { sessionId?: string; event?: { kind?: string; text?: string; sessionId?: string } };
        if (envelope.event?.kind === "assistant.text_delta" && typeof envelope.event.text === "string") report += envelope.event.text;
        sessionId = envelope.event?.sessionId ?? envelope.sessionId ?? sessionId;
      } catch { /* structured output is retained even if one line is malformed */ }
    }
    if (!report) report = diagnostics || `Maintenance analysis exited with code ${exitCode}.\n`;
    return { exitCode, report, events, ...(sessionId ? { sessionId } : {}) };
  };
}
