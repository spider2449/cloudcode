import { execFile } from "node:child_process";
import type { ToolDef } from "./types.js";

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 120000;

function shellArgs(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { cmd: "/bin/sh", args: ["-c", command] };
}

export const bashTool: ToolDef = {
  name: "Bash",
  description: "Run a shell command (PowerShell on Windows, sh elsewhere) and return its output.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" }
    },
    required: ["command"]
  },
  execute(input, ctx) {
    const { cmd, args } = shellArgs(String(input.command ?? ""));
    const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT;
    return new Promise(resolvePromise => {
      execFile(cmd, args, { cwd: ctx.cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        let content = [stdout, stderr].filter(Boolean).join("\n");
        if (content.length > MAX_OUTPUT) content = content.slice(0, MAX_OUTPUT) + "\n… (output truncated)";
        if (err) {
          const killed = (err as { killed?: boolean }).killed;
          const code = (err as { code?: number | string }).code;
          const reason = killed ? `Command timed out after ${timeout}ms` : `Command failed with exit code ${code ?? "unknown"}`;
          resolvePromise({ content: `${reason}\n${content}`.trim(), isError: true });
        } else {
          resolvePromise({ content: content || "(no output)" });
        }
      });
    });
  }
};
