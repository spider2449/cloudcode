import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRegistry } from "../src/commands/builtins.js";
import { loadSettings, saveSetting } from "../src/agent/settings.js";
import { loadThemeName } from "../src/ui/theme.js";
import { mockCtx } from "./helpers/commandContext.js";

vi.mock("../src/agent/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({}),
  saveSetting: vi.fn()
}));
vi.mock("../src/ui/theme.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ui/theme.js")>()),
  loadThemeName: vi.fn().mockReturnValue("dark")
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockReturnValue({});
  vi.mocked(loadThemeName).mockReturnValue("dark");
});

describe("/config", () => {
  it("opens the picker when no arg is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({ provider: "local" });
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "");
    expect(ctx.openConfigPicker).toHaveBeenCalled();
    expect(ctx.notice).not.toHaveBeenCalled();
  });

  it("shows a key's value plus valid options when no value is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({});
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "theme");
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("theme = dark"));
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Valid: "));
    await buildRegistry().get("config")!.run(ctx, "model");
    // Model list unavailable for this mock provider: no bogus options offered.
    expect(ctx.notice).toHaveBeenCalledWith("model = (unset)\nValid: ");
  });

  it("rejects an unknown key", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "editor vim");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown key: editor. Keys: provider, model, permissionMode, networkMode, theme, effort, autoMemory");
  });

  it("sets provider: persists then switches live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider local");
    expect(saveSetting).toHaveBeenCalledWith("provider", "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
    expect(ctx.notice).toHaveBeenCalledWith("provider = local (saved)");
  });

  it("rejects an unknown provider without persisting", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider nope");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.switchProvider).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown provider: nope. Providers: anthropic, local");
  });

  it("sets model: persists then applies live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "model claude-sonnet-5");
    expect(saveSetting).toHaveBeenCalledWith("model", "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(ctx.notice).toHaveBeenCalledWith("model = claude-sonnet-5 (saved)");
  });

  it("sets permissionMode with validation", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "permissionMode acceptEdits");
    expect(saveSetting).toHaveBeenCalledWith("permissionMode", "acceptEdits");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    await buildRegistry().get("config")!.run(ctx, "permissionMode yolo");
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("applies bypassPermissions live but never persists it", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "permissionMode bypassPermissions");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("permissionMode = bypassPermissions (session only, not saved)");
  });

  it("sets only persistable network modes and applies them live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "networkMode offlineStrict");
    expect(ctx.setNetworkMode).toHaveBeenCalledWith("offlineStrict");
  });

  it("applies unrestricted live but never persists it", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "networkMode unrestricted");
    expect(ctx.setSessionNetworkMode).toHaveBeenCalledWith("unrestricted");
    expect(ctx.setNetworkMode).not.toHaveBeenCalled();
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("networkMode = unrestricted (session only, not saved)");
    await buildRegistry().get("config")!.run(ctx, "networkMode yolo");
    expect(ctx.notice).toHaveBeenCalledWith(
      "Valid modes: offlineStrict, providerOnly, unrestricted (unrestricted is session only)"
    );
  });

  it("sets theme by delegating to setTheme, never touching settings.json", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "theme mono");
    expect(ctx.setTheme).toHaveBeenCalledWith("mono");
    expect(saveSetting).not.toHaveBeenCalledWith("theme", expect.anything());
    expect(ctx.notice).toHaveBeenCalledWith("theme = mono (saved)");
    await buildRegistry().get("config")!.run(ctx, "theme nonexistent");
    expect(ctx.setTheme).not.toHaveBeenCalledWith("nonexistent");
    expect(ctx.notice).toHaveBeenCalledWith(
      "Unknown theme: nonexistent. Themes: dark, light, mono, dracula, catppuccin, gruvbox, tokyonight, nord, one-dark, solarized, rosepine, github, monokai",
    );
  });

  it("sets effort", async () => {
    const cmd = buildRegistry().get("config")!;
    const ctx = mockCtx();
    await cmd.run(ctx, "effort low");
    expect(saveSetting).toHaveBeenCalledWith("effort", "low");
    expect(ctx.setEffort).toHaveBeenCalledWith("low");
  });

  it("completes keys and values", () => {
    const cmd = buildRegistry().get("config")!;
    const cctx = { providerNames: () => ["anthropic", "local"], availableModels: () => ["claude-sonnet-5"] } as never;
    expect(cmd.completeArgs!("p", cctx)).toEqual(["provider", "permissionMode"]);
    expect(cmd.completeArgs!("theme m", cctx)).toEqual(["theme mono", "theme monokai"]);
    expect(cmd.completeArgs!("provider l", cctx)).toEqual(["provider local"]);
    expect(cmd.completeArgs!("model cla", cctx)).toEqual(["model claude-sonnet-5"]);
  });

  it("/config autoMemory sets the setting", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "autoMemory false");
    expect(saveSetting).toHaveBeenCalledWith("autoMemoryEnabled", false);
    expect(ctx.notice).toHaveBeenCalledWith("autoMemory = false (saved)");
  });
});

describe("configChoices", () => {
  it("builds entries from live context with current values", async () => {
    const { configChoices } = await import("../src/commands/builtins.js");
    const ctx = mockCtx();
    const entries = configChoices(ctx);
    expect(entries.map(e => e.key)).toEqual([
      "provider", "model", "permissionMode", "networkMode", "theme", "effort", "autoMemory"
    ]);
    const provider = entries.find(e => e.key === "provider");
    if (!provider) throw new Error("missing provider entry");
    expect(provider.choices).toEqual(["anthropic", "local"]);
    const theme = entries.find(e => e.key === "theme");
    expect(theme?.current).toBe("dark");
    expect(theme?.choices).toContain("dark");
    const model = entries.find(e => e.key === "model");
    expect(model?.choices).toEqual([]);
  });
});