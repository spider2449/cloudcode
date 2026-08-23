import type { ToolDef } from "./types.js";
import type { BackgroundShellManager } from "./backgroundShells.js";

export function createBashOutputTool(mgr: BackgroundShellManager): ToolDef {
  return {
    name: "BashOutput",
    description: "Read new output from a background shell started with Bash run_in_background.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Shell id, e.g. b1" } },
      required: ["id"]
    },
    async execute(input) {
      const id = String(input.id ?? "");
      const output = mgr.read(id);
      if (output === undefined) return { content: `Unknown background shell: ${id}`, isError: true };
      const status = mgr.status(id) ?? "exited";
      const code = mgr.exitCode(id);
      const body = output === "" ? "(no new output)" : output;
      return { content: "[" + status + (status === "exited" && code !== undefined ? " (" + code + ")" : "") + "]\n" + body };
    }
  };
}

export function createKillShellTool(mgr: BackgroundShellManager): ToolDef {
  return {
    name: "KillShell",
    description: "Terminate a background shell started with Bash run_in_background.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Shell id, e.g. b1" } },
      required: ["id"]
    },
    async execute(input) {
      const result = await mgr.kill(String(input.id ?? ""));
      if (result === undefined) return { content: `Unknown background shell: ${String(input.id ?? "")}`, isError: true };
      return { content: result || "Background shell killed." };
    }
  };
}
