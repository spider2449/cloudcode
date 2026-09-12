import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyGuiTheme } from "../desktop/renderer/themeState.js";

// Every selector chatPane.tsx / src.tsx actually renders must have a themed
// rule: hardcoded dark hexes elsewhere mean a theme switch only recolors the
// app background while inputs, bubbles, and dialogs stay dark.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "style.css"),
  "utf8"
);
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

function blocksFor(selector: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = match[1].split(",").map(part => part.trim());
    if (parts.some(part => part === selector || part.endsWith(` ${selector}`))) out.push(match[2]);
  }
  expect(out.length, `${selector} missing from style.css`).toBeGreaterThan(0);
  return out;
}

function ruleOf(selector: string): string {
  const blocks = blocksFor(selector);
  return blocks[0] ?? "";
}

describe("desktop theme css follows gui vars", () => {
  it("chatPane permission overlay has a themed style rule", () => {
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("permission-overlay");
    const rule = ruleOf(".permission-overlay");
    expect(rule).toContain("var(--gui-element");
    expect(rule).toContain("var(--gui-accent");
    expect(ruleOf(".permission-overlay button")).toContain("var(--gui-text");
    expect(ruleOf(".permission-overlay pre")).toContain("var(--gui-bg");
  });
  it("core surfaces recolor with the theme instead of hardcoded dark hex", () => {
    for (const selector of [
      ".sidebar",
      ".titlebar",
      ".composer",
      ".chat-input textarea",
      ".chat-list .bubble.user pre",
      ".theme-menu",
      ".slash-complete",
      ".desktop-dialog",
      ".session-card.active",
      ".git-diff pre",
      ".new-session",
      ".inspector"
    ]) {
      expect(blocksFor(selector).some(body => body.includes("var(--gui-")), `${selector} ignores theme vars`).toBe(true);
    }
  });
  it("derives element/hover/border/error-strong layers from the 7 theme vars", () => {
    for (const name of ["--gui-element", "--gui-hover", "--gui-border-strong", "--gui-error-strong"]) {
      expect(code).toContain(`${name}: color-mix(`);
    }
  });
  it("switches native controls to a light color scheme for the light theme", () => {
    expect(code).toContain(':root[data-theme="light"]');
    expect(code).toContain("color-scheme: light");
  });
});

describe("theme switch writes color-scheme to the root", () => {
  afterEach(() => {
    // themeState guards DOM access; the stub must not leak into other tests.
    Reflect.deleteProperty(globalThis, "document");
  });
  function stubDocument(): Record<string, string> {
    const props: Record<string, string> = {};
    const fakeRoot = { dataset: {} as Record<string, string>, style: { setProperty: (k: string, v: string) => { props[k] = v; } } };
    (globalThis as Record<string, unknown>)["document"] = { documentElement: fakeRoot };
    return props;
  }
  it("uses light controls for the light theme and dark otherwise", () => {
    let props = stubDocument();
    expect(applyGuiTheme("light")).toBe("light");
    expect(props["color-scheme"]).toBe("light");
    props = stubDocument();
    expect(applyGuiTheme("dracula")).toBe("dracula");
    expect(props["color-scheme"]).toBe("dark");
    expect(props["--gui-accent"]).toBe("#8be9fd");
  });
});
