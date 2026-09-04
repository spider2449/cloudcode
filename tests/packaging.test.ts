import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.js";

// The packaging inputs are spread across four files that have to agree, and
// nothing but a release ever exercises them together: package.json, the two
// binary build scripts, and the Inno Setup definition. These are static
// consistency checks — they cannot prove a build works, but they catch the
// drift (a bumped version, a renamed artifact) that would otherwise surface
// only when a release is already half-published.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const packageJson = JSON.parse(read("package.json")) as {
  version: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};
const buildPs1 = read("scripts/build-binaries.ps1");
const buildSh = read("scripts/build-binaries.sh");
const iss = read("installer/cloudcode.iss");

const WIN_ARTIFACT = "release/cloudcode-win-x64.exe";

describe("packaging version consistency", () => {
  it("package.json, src/version.ts and the installer state the same version", () => {
    expect(packageJson.version).toBe(VERSION);
    const appVersion = /#define\s+AppVersion\s+"([^"]+)"/.exec(iss)?.[1];
    expect(appVersion).toBe(VERSION);
  });

  it("the installer names its output after that version", () => {
    // OutputBaseFilename interpolates {#AppVersion}; a hardcoded number here
    // would ship cloudcode-setup-0.1.0.exe forever.
    expect(iss).toMatch(/OutputBaseFilename=cloudcode-setup-\{#AppVersion\}/);
  });
});

describe("packaging artifact paths", () => {
  it("both build scripts emit the Windows artifact the installer packages", () => {
    expect(buildPs1).toContain(WIN_ARTIFACT);
    expect(buildSh).toContain(WIN_ARTIFACT);
    const source = /Source:\s*"([^"]+)"/.exec(iss)?.[1];
    expect(source).toBe(`..\\${WIN_ARTIFACT.replace("/", "\\")}`);
  });

  it("both build scripts agree on the Linux artifact name", () => {
    for (const script of [buildPs1, buildSh]) {
      expect(script).toContain("release/cloudcode-linux-x64");
      expect(script).toContain("bun-linux-x64");
    }
  });

  it("the release smoke test checks every binary the build scripts produce", () => {
    const workflow = read(".github/workflows/release-smoke-test.yml");
    // Each `bun-<os>-<arch>:release/<name>` pair in the shell script is an
    // artifact a release publishes; the smoke test should run each one.
    const outputs = [...buildSh.matchAll(/"bun-[\w-]+:(release\/[\w.-]+)"/g)].map(m => m[1]);
    expect(outputs.length).toBeGreaterThan(0);
    const unchecked = outputs.filter(o => !workflow.includes(o));
    expect(unchecked).toEqual([]);
  });

  it("the release smoke test actually compiles and checks the installer", () => {
    // Compiling is the only real validation of the .iss definition; without
    // this leg a broken installer surfaces mid-release on a dev machine.
    const workflow = read(".github/workflows/release-smoke-test.yml");
    expect(workflow).toContain("build-installer.ps1");
    const base = /OutputBaseFilename=([\w{}#-]+)/.exec(iss)?.[1];
    expect(base).toBe("cloudcode-setup-{#AppVersion}");
    // The artifact check must derive the version the same way the installer
    // names its output: from AppVersion, which packaging pins to src/version.ts.
    expect(workflow).toContain("src/version.ts");
    expect(workflow).toContain("cloudcode-setup-");
  });
});

describe("packaging entry points", () => {
  it("every packaging script package.json references exists", () => {
    const referenced = Object.values(packageJson.scripts)
      .flatMap(cmd => [...cmd.matchAll(/(scripts\/[\w.-]+)/g)].map(m => m[1]));
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) expect(existsSync(join(root, path))).toBe(true);
  });

  it("the compiled-binary entry point and the npm bin entry both exist as sources", () => {
    // bin points at build output (dist/), so check the source it comes from.
    expect(packageJson.bin.cloudcode).toBe("dist/cli.js");
    expect(existsSync(join(root, "src/cli.tsx"))).toBe(true);
    expect(existsSync(join(root, "scripts/bin-entry.ts"))).toBe(true);
  });

  it("the npm package ships every path it lists in files", () => {
    // dist/ only exists after a build, so it is checked as a build target
    // rather than as a file that must be present in a clean checkout.
    for (const entry of packageJson.files.filter(f => f !== "dist")) {
      expect(existsSync(join(root, entry))).toBe(true);
    }
    expect(packageJson.scripts.build).toContain("tsc");
  });

  it("ships the workflow-pack schema, guide, and inert reference fixture", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining(["docs/packs", "examples/packs"]));
    expect(existsSync(join(root, "docs/packs/cloudcode-pack.schema.json"))).toBe(true);
    expect(existsSync(join(root, "docs/packs/authoring.md"))).toBe(true);
    expect(existsSync(join(root, "examples/packs/reference-inert/cloudcode-pack.json"))).toBe(true);
    expect(packageJson.files).toContain("docs/local-first-automation.md");
    expect(existsSync(join(root, "docs/local-first-automation.md"))).toBe(true);
  });
});

describe("desktop packaging", () => {
  it("declares electron-builder with bundled CLI file list", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
      build: {
        appId: string;
        directories: { output: string };
        files: string[];
        asarUnpack?: string[];
      };
      scripts: Record<string, string>;
    };
    expect(pkg.devDependencies["electron-builder"]).toBeDefined();
    expect(pkg.build.appId).toBe("app.cloudcode");
    expect(pkg.build.directories.output).toBe("release/desktop");
    for (const pattern of ["dist/**", "desktop/dist/**", "desktop/preload.cjs"]) {
      expect(pkg.build.files).toContain(pattern);
    }
    // The desktop terminal spawns a plain node.exe child, which cannot read
    // files inside app.asar — dist/ must be unpacked to disk (see the
    // MODULE_NOT_FOUND for resources/app/dist/cli.js) and main.mjs must
    // resolve the unpacked location.
    expect(pkg.build.asarUnpack).toEqual(expect.arrayContaining(["dist/**/*"]));
    // Bare imports (e.g. @anthropic-ai/sdk) inside the unpacked CLI resolve
    // via node_modules on disk, so production dependencies must be unpacked
    // too — otherwise the child exits with ERR_MODULE_NOT_FOUND.
    expect(pkg.build.asarUnpack).toEqual(expect.arrayContaining(["node_modules/**/*"]));
    expect(read("desktop/main.mjs")).toContain("app.asar.unpacked");
    expect(pkg.scripts["desktop:dist"]).toContain("desktop-package.mjs");
    expect(pkg.scripts["desktop:package"]).toContain("desktop-package.mjs");
  });

  it("the desktop orchestrator script exists and guards build output", () => {
    expect(existsSync(join(root, "scripts/desktop-package.mjs"))).toBe(true);
    expect(read("scripts/desktop-package.mjs")).toContain("desktop/dist");
  });
});
