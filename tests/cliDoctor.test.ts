import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNodeVersion, checkJsonFile, checkProviderKeys, runDoctor, formatDoctor
} from "../src/commands/cli/doctor.js";

const dir = () => mkdtempSync(join(tmpdir(), "doctor-"));

describe("doctor checks", () => {
  it("accepts node >= 18 and rejects older", () => {
    expect(checkNodeVersion("v22.1.0").ok).toBe(true);
    expect(checkNodeVersion("v16.20.0").ok).toBe(false);
  });

  it("treats a missing json file as ok and invalid json as a failure", () => {
    const d = dir();
    expect(checkJsonFile("providers.json", join(d, "nope.json")).ok).toBe(true);
    const bad = join(d, "bad.json");
    writeFileSync(bad, "not json{{");
    const check = checkJsonFile("providers.json", bad);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not valid JSON");
  });

  it("resolves anthropic keys from config or env, openai only from config", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test" };
    const checks = checkProviderKeys(
      { anthropic: {}, local: { kind: "openai", baseUrl: "http://x" } },
      env
    );
    expect(checks.find(c => c.name.includes("anthropic"))?.ok).toBe(true);
    expect(checks.find(c => c.name.includes("local"))?.ok).toBe(false);
  });

  it("runDoctor passes end to end on a healthy temp setup", () => {
    const d = dir();
    const checks = runDoctor({ dir: d, cwd: dir(), env: { ANTHROPIC_API_KEY: "sk-test" } });
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it("formatDoctor marks failures", () => {
    const out = formatDoctor([
      { name: "a", ok: true, detail: "fine" },
      { name: "b", ok: false, detail: "broken" }
    ]);
    expect(out).toContain("ok    a");
    expect(out).toContain("FAIL  b");
  });
});
