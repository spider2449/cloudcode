import { describe, expect, it, vi } from "vitest";
import { NetworkController } from "../src/ui/networkController.js";

describe("NetworkController", () => {
  it("owns mode, provider scoping, audit, and the visible guarantee", () => {
    const record = vi.fn();
    const controller = new NetworkController(
      "providerOnly", { local: { baseUrl: "http://127.0.0.1:8080" } }, { record }, false
    );
    controller.policyFor("local").require({ capability: "provider", destination: "http://127.0.0.1:8080/v1" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ allowed: true, destinationHost: "127.0.0.1" }));
    expect(controller.notice()).toContain("Bash networking: uncontained");
    controller.setMode("offlineStrict");
    expect(controller.mode).toBe("offlineStrict");
    expect(controller.notice()).toContain("Bash networking: disabled");
  });

  it("policies already handed to a running session follow setMode", () => {
    const controller = new NetworkController(
      "providerOnly", {}, undefined
    );
    const issued = controller.policyFor("anthropic");
    expect(() => issued.require({ capability: "webFetch", destination: "https://github.com" })).toThrow();
    controller.setMode("unrestricted");
    expect(issued.mode).toBe("unrestricted");
    expect(() => issued.require({ capability: "webFetch", destination: "https://github.com" })).not.toThrow();
  });

  it("notice reports contained when offlineStrict and verified", () => {
    const controller = new NetworkController("offlineStrict", {}, undefined, true);
    expect(controller.notice()).toContain("Bash networking: contained");
  });

  it("notice reports disabled when offlineStrict and not verified", () => {
    const controller = new NetworkController("offlineStrict", {}, undefined, false);
    expect(controller.notice()).toContain("Bash networking: disabled");
  });
});
