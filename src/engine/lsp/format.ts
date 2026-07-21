import { fileURLToPath } from "node:url";
import type { Diagnostic, Location } from "./server.js";

function uriToPath(uri: string): string {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

export function formatLocations(locations: Location[], cap: number): string {
  if (locations.length === 0) return "No results.";
  const shown = locations.slice(0, cap)
    .map(l => `${uriToPath(l.uri)}:${l.line + 1}:${l.column + 1}`);
  if (locations.length > cap) shown.push(`(${locations.length - cap} more)`);
  return shown.join("\n");
}

export function formatHover(raw: unknown): string {
  const hover = raw as { contents?: unknown } | null;
  const contents = hover?.contents;
  if (contents == null) return "No hover information.";
  const part = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && "value" in c) return String((c as { value: unknown }).value);
    return "";
  };
  const text = Array.isArray(contents) ? contents.map(part).join("\n") : part(contents);
  return text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim() || "No hover information.";
}

function severityLabel(severity: number): string {
  return severity === 1 ? "error" : severity === 2 ? "warning" : severity === 3 ? "info" : "hint";
}

export function formatDiagnosticsBlock(fileLabel: string, diags: Diagnostic[], cap: number): string {
  if (diags.length === 0) return "";
  const sorted = [...diags].sort((a, b) => a.severity - b.severity || a.line - b.line);
  const lines = sorted.slice(0, cap).map(d => {
    const code = d.code ? `${d.code}: ` : "";
    return `${fileLabel}:${d.line + 1}:${d.column + 1} ${severityLabel(d.severity)} ${code}${d.message}`;
  });
  return [
    "--- diagnostics (edited file) ---",
    ...lines,
    `(${diags.length} issue${diags.length === 1 ? "" : "s"})`
  ].join("\n");
}
