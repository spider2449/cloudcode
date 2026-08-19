import type { EventEnvelope, RunResultMetadata } from "./events.js";

export type OutputFormat = "text" | "json" | "stream-json";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat);
}

export interface JsonRunDocument {
  schemaVersion: 1;
  events: EventEnvelope[];
  result: RunResultMetadata;
}

export function serializeEvent(event: EventEnvelope): string {
  return JSON.stringify(event) + "\n";
}

export function serializeJsonRun(events: EventEnvelope[], result: RunResultMetadata): string {
  const document: JsonRunDocument = { schemaVersion: 1, events, result };
  return JSON.stringify(document) + "\n";
}
