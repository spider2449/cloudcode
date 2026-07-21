import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVERS, loadRegistry } from "../../src/engine/lsp/config.js";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lsp-"));
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("loadRegistry", () => {
  it("returns defaults when no config files exist", () => {
    const reg = loadRegistry("/no/such/user.json", "/no/such/project.json");
    expect(Object.keys(reg).sort()).toEqual(["go", "python", "rust", "typescript"]);
    expect(reg.typescript.command).toBe(DEFAULT_SERVERS.typescript.command);
  });

  it("merges a user override onto a default entry", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ typescript: { command: "my-ts", args: ["--stdio"] } }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.typescript.command).toBe("my-ts");
    expect(reg.typescript.extensions).toEqual(DEFAULT_SERVERS.typescript.extensions);
  });

  it("adds a new language from config", () => {
    const user = tmpFile("lsp.json", JSON.stringify({
      elixir: { extensions: [".ex"], command: "elixir-ls", args: [], rootMarkers: ["mix.exs"] }
    }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.elixir.command).toBe("elixir-ls");
  });

  it("removes an entry disabled with enabled:false", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ go: { enabled: false } }));
    const reg = loadRegistry(user, "/no/such/project.json");
    expect(reg.go).toBeUndefined();
  });

  it("lets project config win over user config", () => {
    const user = tmpFile("lsp.json", JSON.stringify({ python: { command: "user-py" } }));
    const project = tmpFile("lsp.json", JSON.stringify({ python: { command: "project-py" } }));
    const reg = loadRegistry(user, project);
    expect(reg.python.command).toBe("project-py");
  });
});
