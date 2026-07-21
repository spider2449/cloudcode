import { readFileSync } from "node:fs";
import { isAbsolute, resolve, basename } from "node:path";
import { fileUri, type LspManager } from "./manager.js";
import { formatDiagnosticsBlock } from "./format.js";

const EDIT_TOOLS = new Set(["Edit", "Write"]);
const WAIT_MS = 1500;
const CAP = 10;

export async function appendDiagnostics(
  toolName: string,
  input: Record<string, unknown>,
  content: string,
  lsp: LspManager | undefined,
  cwd: string
): Promise<string> {
  if (!lsp || !EDIT_TOOLS.has(toolName)) return content;
  const file = typeof input.file_path === "string" ? input.file_path : "";
  if (!file) return content;
  const abs = isAbsolute(file) ? file : resolve(cwd, file);

  const server = await lsp.serverFor(abs, cwd);
  if (!server) return content;
  const uri = fileUri(abs);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return content;
  }
  server.didChange(uri, text);
  const diags = await lsp.waitForDiagnostics(uri, WAIT_MS);
  const block = formatDiagnosticsBlock(basename(abs), diags, CAP);
  return block ? `${content}\n\n${block}` : content;
}
