import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  execPath: string;
  env: NodeJS.ProcessEnv;
}

export function resolveNodeExecutable(input: RuntimeEnvironment = {
  platform: process.platform,
  execPath: process.execPath,
  env: process.env
}): string {
  const configured = input.env.CLOUDCODE_NODE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const npmNode = input.env.npm_node_execpath;
  if (npmNode && existsSync(npmNode)) return npmNode;

  const executable = input.platform === "win32" ? "node.exe" : "node";
  for (const directory of (input.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  // Electron can run the CLI in Node mode as a last resort. Prefer a real
  // Node executable because Electron-in-Node-mode does not stream PTY output
  // through node-pty on Windows.
  if (input.execPath && existsSync(input.execPath)) return input.execPath;
  throw new Error(`CloudCode Desktop requires ${executable}. Set CLOUDCODE_NODE_EXECUTABLE to its absolute path.`);
}
