import { describe, expect, it, vi } from "vitest";
import { NetworkController } from "../src/ui/networkController.js";

describe("NetworkController", () => {
  it("owns mode, provider scoping, audit, and the visible guarantee", () => {
    const record = vi.fn();
    const controller = new NetworkController(
      "providerOnly", { local: { baseUrl: "http://127.0.0.1:8080" } }, { record }
    );
    controller.policyFor("local").require({ capability: "provider", destination: "http://127.0.0.1:8080/v1" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ allowed: true, destinationHost: "127.0.0.1" }));
    expect(controller.notice()).toContain("Bash networking: uncontained");
    controller.setMode("offlineStrict");
    expect(controller.mode).toBe("offlineStrict");
    expect(controller.notice()).toContain("Bash networking: disabled");
  });
});
