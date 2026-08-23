import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EXIT_CODES } from "../../print/exitCodes.js";
import { decideNetwork } from "../../agent/networkPolicy.js";
import {
  buildAuthorizeUrl, exchangeCode, generateVerifier, parsePastedCode,
  loadOwnCredentials, saveCredentials, clearCredentials,
  loadBorrowedCredentials, TOKEN_ENDPOINT
} from "../../agent/oauth.js";

export interface LoginDeps {
  configBase?: string;
  home?: string;
  networkMode: "offlineStrict" | "providerOnly" | "unrestricted";
  fetchImpl?: typeof fetch;
  promptText?(label: string): Promise<string>;
  openBrowser?(url: string): void;
}

function defaultPrompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(label, answer => { rl.close(); resolve(answer); }));
}

function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* manual copy */ }
}

export async function runLoginCommand(
  args: string[],
  deps: LoginDeps
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const verb = args[0] ?? "status";

  if (verb === "logout") {
    clearCredentials(deps.configBase);
    return { exitCode: 0, stdout: "Logged out (cloudcode credentials removed)." };
  }

  if (verb === "status") {
    const own = loadOwnCredentials(deps.configBase);
    if (own) {
      return { exitCode: 0, stdout: `Logged in via claude.ai OAuth (access token expires ${new Date(own.expiresAt).toLocaleString()}).` };
    }
    if (loadBorrowedCredentials(deps.home)) {
      return { exitCode: 0, stdout: "Using an existing Claude Code login (~/.claude). Run `cloudcode login` to manage your own credentials." };
    }
    return { exitCode: 0, stdout: "Not logged in. Set ANTHROPIC_API_KEY or run `cloudcode login`." };
  }

  if (verb !== "login") {
    return { exitCode: EXIT_CODES.invalidConfiguration, stderr: `Unknown login verb "${verb}". Use login | logout | status.` };
  }

  // Exchange hits console.anthropic.com: cloudcode-owned egress, denied
  // outside unrestricted by the privacy contract.
  const decision = decideNetwork(deps.networkMode, { capability: "oauth", destination: TOKEN_ENDPOINT });
  if (!decision.allowed) {
    return {
      exitCode: EXIT_CODES.invalidConfiguration,
      stderr: `Login requires network access (${decision.mode}/${decision.reason}). Re-run: --network-mode unrestricted cloudcode login`
    };
  }

  const verifier = generateVerifier();
  const url = buildAuthorizeUrl(verifier);
  console.log([
    "Open this URL in a browser and approve access:",
    "",
    `  ${url}`,
    "",
    "Then paste the code shown after approval (with or without the #state suffix):"
  ].join("\n"));
  deps.openBrowser?.(url);
  const prompt = deps.promptText ?? defaultPrompt;
  const pasted = await prompt("> ");
  // state === verifier by construction; PKCE binds the exchange to the
  // verifier, so any pasted #state suffix is ignored here.
  const { code } = parsePastedCode(pasted);
  try {
    const tokens = await exchangeCode(code, verifier, deps.fetchImpl);
    saveCredentials(tokens, deps.configBase);
    return { exitCode: 0, stdout: `\nLogged in. Access token expires ${new Date(tokens.expiresAt).toLocaleString()}.` };
  } catch (err) {
    return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
  }
}
