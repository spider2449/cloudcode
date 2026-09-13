// GUI theme state. Pure data plus DOM/storage side effects, kept window-free
// at module scope so node-based unit tests can import this module directly
// (same pattern as lastSelection.ts). Hex values are the resolved TUI roles
// (background, backgroundPanel, text, textMuted, accent, border, error) for
// each builtin theme; dark/mono keep the GUI's established look because
// those TUI definitions carry no background roles, and light gets a matching
// light set for the same reason.
import { THEMES } from "../../src/ui/builtinThemes.js";

export interface GuiThemeVars {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  error: string;
}

export const GUI_THEME_STORAGE_KEY = "cloudcode.theme";

const DARK_LOOK: GuiThemeVars = {
  bg: "#111317",
  panel: "#181a1f",
  text: "#e7e9ed",
  muted: "#9ba1ab",
  accent: "#668bc7",
  border: "#2a2d33",
  error: "#e2a9ae"
};

const LIGHT_LOOK: GuiThemeVars = {
  bg: "#f5f5f4",
  panel: "#ffffff",
  text: "#1a2029",
  muted: "#656b75",
  accent: "#53657f",
  border: "#d8d8d2",
  error: "#800000"
};

function varsFromTui(name: string): GuiThemeVars | undefined {
  const t = THEMES[name] as Record<string, string> | undefined;
  if (!t) return undefined;
  if (t["background"] === undefined) return undefined;
  const pick = (key: string, fallback: string): string => {
    const v = t[key];
    return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };
  return {
    bg: pick("background", DARK_LOOK.bg),
    panel: pick("backgroundPanel", DARK_LOOK.panel),
    text: pick("text", DARK_LOOK.text),
    muted: pick("textMuted", DARK_LOOK.muted),
    accent: pick("accent", DARK_LOOK.accent),
    border: pick("border", DARK_LOOK.border),
    error: pick("error", DARK_LOOK.error)
  };
}

// Covers every TUI theme name so /theme never misses in the GUI. Custom
// themes registered at runtime resolve dynamically via guiThemeVars().
export const GUI_THEMES: Record<string, GuiThemeVars> = {};
for (const name of Object.keys(THEMES)) {
  if (name === "light") GUI_THEMES[name] = LIGHT_LOOK;
  else GUI_THEMES[name] = varsFromTui(name) ?? DARK_LOOK;
}

export function resolveGuiTheme(name: string): string {
  if (name in THEMES) return name;
  if (name in GUI_THEMES) return name;
  return "dark";
}

export function guiThemeVars(name: string): GuiThemeVars {
  const resolved = resolveGuiTheme(name);
  return varsFromTui(resolved) ?? GUI_THEMES[resolved] ?? DARK_LOOK;
}

// Writes the palette onto the running window (CSS variables on the root
// element). Guards DOM access so unit tests can import this module under
// node.
function setThemeVars(resolved: string, vars: GuiThemeVars): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.dataset["theme"] = resolved;
  const style = root.style;
  style.setProperty("--gui-bg", vars.bg);
  style.setProperty("--gui-panel", vars.panel);
  style.setProperty("--gui-text", vars.text);
  style.setProperty("--gui-muted", vars.muted);
  style.setProperty("--gui-accent", vars.accent);
  style.setProperty("--gui-border", vars.border);
  style.setProperty("--gui-error", vars.error);
  // Native controls (scrollbars, selects, inputs) follow the theme too;
  // without this a light theme keeps dark scrollbars. The stylesheet also
  // carries a :root[data-theme="light"] rule as a second layer.
  style.setProperty("color-scheme", resolved === "light" ? "light" : "dark");
}

// Previews a theme without persisting anything: the in-app menu calls this
// on every highlight move, so cancelling reverts without a trace.
export function previewGuiTheme(name: string): string {
  const resolved = resolveGuiTheme(name);
  try {
    setThemeVars(resolved, guiThemeVars(resolved));
  } catch {
    // DOM access can fail in restricted contexts; preview just won't show.
  }
  return resolved;
}

// Last backend-confirmed theme (persisted in settings.json and echoed back
// as a theme chat event). The menu reverts to this on cancel, so browsing
// never persists anything by itself.
let confirmedTheme: string | undefined;

export function getConfirmedGuiTheme(): string {
  if (!confirmedTheme) confirmedTheme = loadStoredGuiTheme() ?? "dark";
  return confirmedTheme;
}

// Records a backend-confirmed theme: applies it now and remembers it as the
// revert target for the next menu session.
export function confirmGuiTheme(name: string): string {
  confirmedTheme = applyGuiTheme(name);
  return confirmedTheme;
}

// Applies the theme to the running window immediately (CSS variables on the
// root element) and persists it for next launch. Guards DOM/storage access
// so unit tests can import this module under node.
export function applyGuiTheme(name: string): string {
  const resolved = resolveGuiTheme(name);
  try {
    setThemeVars(resolved, guiThemeVars(resolved));
  } catch {
    // DOM access can fail in restricted contexts; persistence below still applies.
  }
  try {
    globalThis.localStorage?.setItem(GUI_THEME_STORAGE_KEY, resolved);
  } catch {
    // Storage (private mode, quota) must never break a theme switch.
  }
  return resolved;
}

// Extracts the theme name from a "theme" chat event so the renderer can
// recolor immediately. Anything else yields undefined instead of throwing
// on malformed payloads.
export function parseThemeEvent(event: { type: string; text?: unknown }): string | undefined {
  if (event.type !== "theme") return undefined;
  return typeof event.text === "string" && event.text !== "" ? event.text : undefined;
}

export function loadStoredGuiTheme(): string | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(GUI_THEME_STORAGE_KEY);
    if (typeof stored === "string" && stored !== "") return resolveGuiTheme(stored);
  } catch {
    // Ignore storage failures and fall through to undefined.
  }
  return undefined;
}
