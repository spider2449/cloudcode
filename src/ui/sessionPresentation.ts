import { DEFAULT_CONTEXT_WINDOW, type ProviderConfig } from "../agent/providers.js";
import { VERSION } from "../version.js";
import type { DisplayItem } from "./transcript.js";
import { loadWelcome, splitWelcomeLogo } from "./welcome.js";

/** Pure provider/session labels used by the TUI frame and welcome banner. */
export class SessionPresentation {
  constructor(private providers: Record<string, ProviderConfig>) {}

  modelFor(name: string): string | undefined {
    return this.providers[name]?.model;
  }

  contextWindowFor(name: string): number {
    return this.providers[name]?.model_context_window ?? DEFAULT_CONTEXT_WINDOW;
  }

  welcomeItem(name: string, size: { rows: number; columns: number }): DisplayItem | undefined {
    const welcome = loadWelcome(
      { version: VERSION, provider: name, model: this.modelFor(name) }, undefined,
      { rows: Math.max(1, size.rows - 6), columns: size.columns }
    );
    if (!welcome) return undefined;
    const { logo, body } = splitWelcomeLogo(welcome);
    return logo !== undefined ? { kind: "welcome", logo, body } : { kind: "notice", text: body };
  }
}
