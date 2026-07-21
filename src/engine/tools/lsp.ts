import { isAbsolute, resolve, extname } from "node:path";
import type { ToolDef, ToolContext } from "./types.js";
import { fileUri, type LspManager } from "../lsp/manager.js";
import { formatLocations, formatHover, formatDiagnosticsBlock } from "../lsp/format.js";
import type { Location } from "../lsp/server.js";

const NAV_CAP = 100;

function absPath(file: string, ctx: ToolContext): string {
  return isAbsolute(file) ? file : resolve(ctx.cwd, file);
}

function noLsp(file: string): string {
  return `No LSP server available for ${extname(file) || file}.`;
}

// Resolve a started server for the file, or return a no-op message.
async function withServer(
  file: string,
  ctx: ToolContext
): Promise<{ server: Awaited<ReturnType<LspManager["serverFor"]>>; uri: string; abs: string } | { message: string }> {
  if (!ctx.lsp) return { message: noLsp(file) };
  const abs = absPath(file, ctx);
  const server = await ctx.lsp.serverFor(abs, ctx.cwd);
  if (!server) return { message: noLsp(file) };
  const uri = fileUri(abs);
  return { server, uri, abs };
}

function toLocations(result: unknown): Location[] {
  const arr = Array.isArray(result) ? result : result ? [result] : [];
  return arr
    .map((r: any) => {
      const range = r.range ?? r.targetRange ?? r.targetSelectionRange;
      const uri = r.uri ?? r.targetUri;
      if (!range || !uri) return undefined;
      return { uri, line: range.start.line, column: range.start.character } as Location;
    })
    .filter((l): l is Location => l !== undefined);
}

const posSchema = {
  file: { type: "string", description: "File path (relative to cwd or absolute)" },
  line: { type: "number", description: "1-based line number" },
  column: { type: "number", description: "1-based column number" }
};

async function ensureOpened(handle: { server: any; uri: string; abs: string }): Promise<void> {
  if (!handle.server.isOpen(handle.uri)) {
    const { readFileSync } = await import("node:fs");
    try {
      handle.server.didOpen(handle.uri, readFileSync(handle.abs, "utf8"));
    } catch {
      handle.server.didOpen(handle.uri, "");
    }
  }
}

export const definitionTool: ToolDef = {
  name: "Definition",
  description: "Find where the symbol at a position is defined, using the language server. Returns file:line:col locations.",
  input_schema: { type: "object", properties: posSchema, required: ["file", "line", "column"] },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    try {
      await ensureOpened(h as any);
      const result = await h.server!.request("textDocument/definition", {
        textDocument: { uri: h.uri },
        position: { line: Number(input.line) - 1, character: Number(input.column) - 1 }
      }, ctx.signal);
      return { content: formatLocations(toLocations(result), NAV_CAP) };
    } catch (err) {
      return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};

export const referencesTool: ToolDef = {
  name: "References",
  description: "Find all references to the symbol at a position, using the language server.",
  input_schema: {
    type: "object",
    properties: { ...posSchema, includeDeclaration: { type: "boolean" } },
    required: ["file", "line", "column"]
  },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    try {
      await ensureOpened(h as any);
      const result = await h.server!.request("textDocument/references", {
        textDocument: { uri: h.uri },
        position: { line: Number(input.line) - 1, character: Number(input.column) - 1 },
        context: { includeDeclaration: input.includeDeclaration !== false }
      }, ctx.signal);
      return { content: formatLocations(toLocations(result), NAV_CAP) };
    } catch (err) {
      return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};

export const hoverTool: ToolDef = {
  name: "Hover",
  description: "Get type/signature/documentation for the symbol at a position, using the language server.",
  input_schema: { type: "object", properties: posSchema, required: ["file", "line", "column"] },
  async execute(input, ctx) {
    const h = await withServer(String(input.file ?? ""), ctx);
    if ("message" in h) return { content: h.message };
    try {
      await ensureOpened(h as any);
      const result = await h.server!.request("textDocument/hover", {
        textDocument: { uri: h.uri },
        position: { line: Number(input.line) - 1, character: Number(input.column) - 1 }
      }, ctx.signal);
      return { content: formatHover(result) };
    } catch (err) {
      return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};

export const symbolsTool: ToolDef = {
  name: "Symbols",
  description: "List document symbols for a file, or search workspace symbols by query, using the language server.",
  input_schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "File to list symbols for (document symbols)" },
      query: { type: "string", description: "Query for workspace symbol search" }
    }
  },
  async execute(input, ctx) {
    const query = typeof input.query === "string" ? input.query : "";
    const file = typeof input.file === "string" ? input.file : "";
    if (query) {
      // Workspace symbols: need any available server; use the file's language if given, else fail gracefully.
      const probe = file || "x.ts";
      const h = await withServer(probe, ctx);
      if ("message" in h) return { content: h.message };
      try {
        const result = await h.server!.request("workspace/symbol", { query }, ctx.signal);
        const locs = (Array.isArray(result) ? result : [])
          .map((s: any) => {
            const loc = s.location;
            if (!loc || !loc.uri || !loc.range) return undefined;
            return { uri: loc.uri, line: loc.range.start.line, column: loc.range.start.character } as Location;
          })
          .filter((l): l is Location => l !== undefined);
        return { content: formatLocations(locs, NAV_CAP) };
      } catch (err) {
        return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const h = await withServer(file, ctx);
    if ("message" in h) return { content: h.message };
    try {
      await ensureOpened(h as any);
      const result = await h.server!.request("textDocument/documentSymbol", {
        textDocument: { uri: h.uri }
      }, ctx.signal);
      const locs = (Array.isArray(result) ? result : [])
        .map((s: any) => {
          const range = s.range ?? s.location?.range;
          const uri = s.location?.uri ?? h.uri;
          if (!range || !uri) return undefined;
          return { uri, line: range.start.line, column: range.start.character } as Location;
        })
        .filter((l): l is Location => l !== undefined);
      return { content: formatLocations(locs, NAV_CAP) };
    } catch (err) {
      return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};

export const diagnosticsTool: ToolDef = {
  name: "Diagnostics",
  description: "Report compiler/linter diagnostics from the language server for a file, or across all open files.",
  input_schema: {
    type: "object",
    properties: { file: { type: "string", description: "File to check (omit for all open files)" } }
  },
  async execute(input, ctx) {
    if (!ctx.lsp) return { content: "No LSP server available." };
    const file = typeof input.file === "string" ? input.file : "";
    if (file) {
      const h = await withServer(file, ctx);
      if ("message" in h) return { content: h.message };
      try {
        await ensureOpened(h as any);
        const diags = await ctx.lsp.waitForDiagnostics(h.uri, 1500);
        const block = formatDiagnosticsBlock(file, diags, 20);
        return { content: block || `No diagnostics for ${file}.` };
      } catch (err) {
        return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    try {
      const parts: string[] = [];
      for (const uri of ctx.lsp.openFiles()) {
        const block = formatDiagnosticsBlock(uri, ctx.lsp.diagnosticsFor(uri), 20);
        if (block) parts.push(block);
      }
      return { content: parts.length ? parts.join("\n\n") : "No diagnostics." };
    } catch (err) {
      return { content: `LSP request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
};
